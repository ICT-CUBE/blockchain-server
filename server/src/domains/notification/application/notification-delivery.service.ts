import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { buildCanonicalString, computeHmacSignatureHex } from '../../../shared/auth/hmac/canonical-request';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { AuditWriter } from '../../audit/application/audit-writer';
import { FailureCode } from '../../audit/persistence/failure-record.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import {
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '../persistence/notification-delivery.entity';
import { NotificationOutboxRepository } from '../persistence/notification-outbox.repository';

/** HTTP statuses worth retrying: network/timeout failures (no response at all), 5xx, and 429. Every
 * other 4xx is a permanent rejection of this payload — retrying it verbatim will never succeed. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * TASK-12 §5's delivery mechanics: HMAC-signs and POSTs one outbox row, classifies the outcome
 * (2xx -> delivered -> Operation COMPLETED; retryable failure -> exponential backoff+jitter;
 * permanent failure or auto-retry budget exhausted -> REVIEW_REQUIRED, Operation stays
 * ONCHAIN_CONFIRMED), and exposes the manual `redeliver` path a CLI/internal job drives (TASK-12
 * §5: "HTTP Admin API는 만들지 않는다").
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly outbox: NotificationOutboxRepository,
    private readonly operationRepository: OperationRepository,
    private readonly appConfig: AppConfigService,
    private readonly auditWriter: AuditWriter,
  ) {}

  async attemptDelivery(delivery: NotificationDelivery): Promise<void> {
    const bodyString = JSON.stringify(delivery.payload);
    const { status, errorMessage } = await this.post(bodyString);

    if (status !== null && status >= 200 && status < 300) {
      await this.outbox.markDelivered(delivery.id);
      try {
        await this.operationRepository.transition(
          delivery.operationId,
          OperationStatus.ONCHAIN_CONFIRMED,
          OperationStatus.COMPLETED,
          'NOTIFICATION_DELIVERED',
        );
      } catch (error) {
        // Operation already moved on (or was never ONCHAIN_CONFIRMED — shouldn't happen, but not
        // this method's problem to fix): the webhook still delivered successfully either way.
        this.logger.warn(
          `Notification ${delivery.notificationId} delivered, but Operation ${delivery.operationId} could not move to COMPLETED: ${(error as Error).message}`,
        );
      }
      return;
    }

    const retryable = status === null || isRetryableStatus(status);
    const nextAttemptCount = delivery.attemptCount + 1;

    if (!retryable || nextAttemptCount >= this.appConfig.notification.maxAutoRetries) {
      await this.outbox.markAttemptFailed(
        delivery.id,
        NotificationDeliveryStatus.REVIEW_REQUIRED,
        new Date(),
        errorMessage ?? `HTTP ${String(status)}`,
      );
      this.logger.warn(
        `Notification ${delivery.notificationId} exhausted auto-retry (or hit a permanent failure): ${errorMessage ?? status}`,
      );
      await this.auditWriter
        .writeFailure({
          code: FailureCode.WEBHOOK_FAILED,
          operationId: delivery.operationId,
          notificationId: delivery.notificationId,
          details: { status, errorMessage, attemptCount: nextAttemptCount },
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Failure-record write failed for notification ${delivery.notificationId}: ${(error as Error).message}`,
          );
        });
      return;
    }

    const backoffMs = this.computeBackoffMs(nextAttemptCount);
    await this.outbox.markAttemptFailed(
      delivery.id,
      NotificationDeliveryStatus.RETRYING,
      new Date(Date.now() + backoffMs),
      errorMessage ?? `HTTP ${String(status)}`,
    );
  }

  /** Exponential backoff with jitter: `base * 2^(attempt-1)`, capped at `maxBackoffMs`, plus up to
   * 20% random jitter (also capped) so many simultaneously-failing notifications don't all retry in
   * lockstep. */
  computeBackoffMs(attemptCount: number): number {
    const { baseBackoffMs, maxBackoffMs } = this.appConfig.notification;
    const exponential = Math.min(baseBackoffMs * 2 ** (attemptCount - 1), maxBackoffMs);
    const jitter = Math.random() * exponential * 0.2;
    return Math.min(Math.round(exponential + jitter), maxBackoffMs);
  }

  /** Resets a REVIEW_REQUIRED/FAILED notification back to PENDING under the same `notificationId`
   * (the receiver's dedup key) and immediately attempts delivery once, so a manual redeliver gets
   * synchronous feedback rather than waiting for the next worker tick. */
  async redeliver(notificationId: string): Promise<NotificationDelivery> {
    const reset = await this.outbox.resetForRedelivery(notificationId);
    this.logger.log(`Redelivering notification ${notificationId} (operation ${reset.operationId})`);
    await this.attemptDelivery(reset);
    const updated = await this.outbox.findByNotificationId(notificationId);
    if (!updated) {
      throw new Error(`Notification ${notificationId} vanished during redelivery`);
    }
    return updated;
  }

  private async post(bodyString: string): Promise<{ status: number | null; errorMessage: string | null }> {
    const { callbackUrl, timeoutMs, hmacOutbound } = this.appConfig.notification;
    const url = new URL(callbackUrl);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const canonical = buildCanonicalString({
      method: 'POST',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      timestamp,
      nonce,
      rawBody: Buffer.from(bodyString, 'utf8'),
    });
    const signature = computeHmacSignatureHex(hmacOutbound.secret, canonical);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ARZONE-Key-Id': hmacOutbound.keyId,
          'X-ARZONE-Timestamp': timestamp,
          'X-ARZONE-Nonce': nonce,
          'X-ARZONE-Signature': signature,
        },
        body: bodyString,
        signal: controller.signal,
      });
      return { status: response.status, errorMessage: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      // Network failure or our own timeout abort — either way, no response was received. Never
      // log the secret or signature, only the outcome (TASK-12 §11: "secret 미로그").
      return { status: null, errorMessage: (error as Error).message };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
