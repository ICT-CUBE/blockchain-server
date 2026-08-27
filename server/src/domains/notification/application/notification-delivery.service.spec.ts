import type { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import type { AuditWriter } from '../../audit/application/audit-writer';
import type { OperationRepository } from '../../operation/persistence/operation.repository';
import {
  NotificationDeliveryStatus,
  type NotificationDelivery,
} from '../persistence/notification-delivery.entity';
import type { NotificationOutboxRepository } from '../persistence/notification-outbox.repository';
import { NotificationDeliveryService } from './notification-delivery.service';

function makeDelivery(overrides: Partial<NotificationDelivery> = {}): NotificationDelivery {
  return {
    id: 'delivery-1',
    notificationId: 'notif-1',
    operationId: 'operation-1',
    status: NotificationDeliveryStatus.PENDING,
    payload: { notificationId: 'notif-1' },
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: new Date(),
    lastError: null,
    lockedUntil: null,
    claimToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(params: { maxAutoRetries?: number } = {}) {
  const outbox = {
    markDelivered: jest.fn().mockResolvedValue(undefined),
    markAttemptFailed: jest.fn().mockResolvedValue(undefined),
  };
  const operationRepository = {
    transition: jest.fn().mockResolvedValue(undefined),
  };
  const appConfig = {
    notification: {
      callbackUrl: 'http://localhost:4100/webhook',
      hmacOutbound: { keyId: 'outbound-v1', secret: Buffer.alloc(32, 9) },
      timeoutMs: 5000,
      maxAutoRetries: params.maxAutoRetries ?? 3,
      baseBackoffMs: 1000,
      maxBackoffMs: 60000,
      pollIntervalMs: 2000,
      batchSize: 20,
    },
  };

  const auditWriter = {
    writeFailure: jest.fn().mockResolvedValue(undefined),
  };

  const service = new NotificationDeliveryService(
    outbox as unknown as NotificationOutboxRepository,
    operationRepository as unknown as OperationRepository,
    appConfig as unknown as AppConfigService,
    auditWriter as unknown as AuditWriter,
  );
  return { service, outbox, operationRepository, auditWriter };
}

describe('NotificationDeliveryService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('computeBackoffMs', () => {
    it('grows exponentially and is capped at maxBackoffMs', () => {
      const { service } = makeService();
      const first = service.computeBackoffMs(1);
      const second = service.computeBackoffMs(2);
      const third = service.computeBackoffMs(3);
      const huge = service.computeBackoffMs(20);

      expect(first).toBeGreaterThanOrEqual(1000);
      expect(second).toBeGreaterThan(first * 0.9); // roughly doubling, allowing for jitter
      expect(third).toBeGreaterThan(second * 0.9);
      expect(huge).toBeLessThanOrEqual(60000);
    });
  });

  describe('attemptDelivery', () => {
    it('marks delivered and completes the Operation on a 2xx response', async () => {
      const { service, outbox, operationRepository } = makeService();
      global.fetch = jest
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ received: true }), { status: 200 }));

      await service.attemptDelivery(makeDelivery());

      expect(outbox.markDelivered).toHaveBeenCalledWith('delivery-1');
      expect(operationRepository.transition).toHaveBeenCalledWith(
        'operation-1',
        OperationStatus.ONCHAIN_CONFIRMED,
        OperationStatus.COMPLETED,
        'NOTIFICATION_DELIVERED',
      );
      expect(outbox.markAttemptFailed).not.toHaveBeenCalled();
    });

    it('retries a 500 response when under the auto-retry budget', async () => {
      const { service, outbox } = makeService({ maxAutoRetries: 3 });
      global.fetch = jest.fn().mockResolvedValue(new Response('error', { status: 500 }));

      await service.attemptDelivery(makeDelivery({ attemptCount: 0 }));

      expect(outbox.markAttemptFailed).toHaveBeenCalledWith(
        'delivery-1',
        NotificationDeliveryStatus.RETRYING,
        expect.any(Date),
        expect.stringContaining('500'),
      );
    });

    it('gives up to REVIEW_REQUIRED once the auto-retry budget is exhausted', async () => {
      const { service, outbox } = makeService({ maxAutoRetries: 3 });
      global.fetch = jest.fn().mockResolvedValue(new Response('error', { status: 500 }));

      await service.attemptDelivery(makeDelivery({ attemptCount: 2 }));

      expect(outbox.markAttemptFailed).toHaveBeenCalledWith(
        'delivery-1',
        NotificationDeliveryStatus.REVIEW_REQUIRED,
        expect.any(Date),
        expect.stringContaining('500'),
      );
    });

    it('does not retry a non-retryable 4xx response even on the first attempt', async () => {
      const { service, outbox } = makeService({ maxAutoRetries: 3 });
      global.fetch = jest.fn().mockResolvedValue(new Response('bad request', { status: 400 }));

      await service.attemptDelivery(makeDelivery({ attemptCount: 0 }));

      expect(outbox.markAttemptFailed).toHaveBeenCalledWith(
        'delivery-1',
        NotificationDeliveryStatus.REVIEW_REQUIRED,
        expect.any(Date),
        expect.stringContaining('400'),
      );
    });

    it('retries 429 (rate limited)', async () => {
      const { service, outbox } = makeService({ maxAutoRetries: 3 });
      global.fetch = jest.fn().mockResolvedValue(new Response('slow down', { status: 429 }));

      await service.attemptDelivery(makeDelivery({ attemptCount: 0 }));

      expect(outbox.markAttemptFailed).toHaveBeenCalledWith(
        'delivery-1',
        NotificationDeliveryStatus.RETRYING,
        expect.any(Date),
        expect.stringContaining('429'),
      );
    });

    it('treats a network/timeout failure as retryable', async () => {
      const { service, outbox } = makeService({ maxAutoRetries: 3 });
      global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      await service.attemptDelivery(makeDelivery({ attemptCount: 0 }));

      expect(outbox.markAttemptFailed).toHaveBeenCalledWith(
        'delivery-1',
        NotificationDeliveryStatus.RETRYING,
        expect.any(Date),
        expect.stringContaining('ECONNREFUSED'),
      );
    });
  });
});
