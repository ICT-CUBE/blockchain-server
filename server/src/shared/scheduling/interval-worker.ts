import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

/**
 * Minimal reusable base for the background pollers TASK-10/11/12 need (signed-attempt recovery,
 * pending-monitor RBF, reconciliation, notification retry) — a plain `setInterval`, not
 * `@nestjs/schedule`: none of these intervals are cron-like, they're all "poll every N ms", and a
 * plain timer keeps `runOnce()` directly callable (and awaitable) from tests without fake timers.
 * Skips a tick if the previous one is still running, so a slow pass never overlaps itself.
 */
@Injectable()
export abstract class IntervalWorker implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly logger: Logger;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  /** Poll interval in milliseconds. */
  protected abstract intervalMs(): number;

  /** One pass of the worker's actual work. Must not throw for expected/transient failures — those
   * should be logged and swallowed internally so one bad tick doesn't stop future ticks. */
  protected abstract runOnce(): Promise<void>;

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs());
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `Unhandled error in scheduled tick: ${(error as Error).message}`,
        (error as Error).stack,
      );
    } finally {
      this.ticking = false;
    }
  }
}
