/**
 * TASK-12 §5's manual redelivery path — deliberately a CLI/internal job, not an HTTP Admin API
 * ("HTTP Admin API는 만들지 않는다"). Boots a minimal Nest application context (full DI, no HTTP
 * listener) so this reuses the exact same `NotificationDeliveryService` the background worker uses,
 * rather than reimplementing delivery logic here.
 *
 * Usage: npm run redeliver -- <notificationId>
 *
 * Every invocation is itself the audit trail for now (actor = whoever ran this, on whichever
 * machine/credentials had access to run it, recorded here as a structured log line) — TASK-14 will
 * fold this into a proper AuditWriter record when that exists; this script does not modify
 * Operation or wallet data directly, only the notification outbox row it targets.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { NotificationDeliveryService } from '../src/domains/notification/application/notification-delivery.service';

async function main(): Promise<void> {
  const notificationId = process.argv[2];
  if (!notificationId) {
    console.error('Usage: npm run redeliver -- <notificationId>');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const deliveryService = app.get(NotificationDeliveryService);
    console.log(
      JSON.stringify({ action: 'redeliver_notification', notificationId, actor: process.env.USER ?? 'unknown', at: new Date().toISOString() }),
    );
    const result = await deliveryService.redeliver(notificationId);
    console.log(
      JSON.stringify({
        notificationId: result.notificationId,
        operationId: result.operationId,
        status: result.status,
        attemptCount: result.attemptCount,
        lastError: result.lastError,
      }),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
