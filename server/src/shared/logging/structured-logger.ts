import { ConsoleLogger, type LoggerService } from '@nestjs/common';

/** The plan's four operational levels (TASK-14 §8: "log level ... 설정"), ordered least-to-most
 * severe. `debug`/`verbose` calls are treated as the same "debug" level as everything else in the
 * codebase only ever calls `.log/.warn/.error/.debug`. */
export type StructuredLogLevel = 'debug' | 'log' | 'warn' | 'error';

const LEVEL_RANK: Record<StructuredLogLevel, number> = { debug: 0, log: 1, warn: 2, error: 3 };

/**
 * One JSON line per log call — `{timestamp, level, context, message}` only, nothing else — so
 * production log aggregation can parse every line the same way. Every call site in this codebase
 * already composes its own message string without ever including a secret (TASK-06/10/12's guards
 * and workers all say so explicitly in their own comments); this class's job is only to emit those
 * messages consistently and to drop anything below the configured level, not to re-filter their
 * content (TASK-14 §5: "로그에는 key ID, request ID, 검증 결과만 남긴다" is upheld by the callers).
 * Installed process-wide via `NestFactory.create(AppModule, { logger })` in `main.ts` so every
 * existing `new Logger(ClassName.name)` call site benefits without being touched individually.
 */
export class StructuredLogger extends ConsoleLogger implements LoggerService {
  private readonly minRank: number;

  constructor(level: StructuredLogLevel = 'log') {
    super();
    this.minRank = LEVEL_RANK[level];
  }

  log(message: unknown, context?: string): void {
    this.emit('log', message, context);
  }

  error(message: unknown, _trace?: string, context?: string): void {
    this.emit('error', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }

  private emit(level: StructuredLogLevel, message: unknown, context?: string): void {
    if (LEVEL_RANK[level] < this.minRank) {
      return;
    }
    const line = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? null,
      message: typeof message === 'string' ? message : String(message),
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }
}

export function structuredLogLevelFromEnv(env: NodeJS.ProcessEnv = process.env): StructuredLogLevel {
  const raw = env.LOG_LEVEL;
  if (raw === 'debug' || raw === 'log' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'log';
}
