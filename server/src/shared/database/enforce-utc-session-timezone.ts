import type { DataSource } from 'typeorm';

/**
 * Pins every MySQL connection in the pool to `time_zone = '+00:00'`.
 *
 * mysql2's `timezone: 'Z'` option (set on the runtime `DatabaseModule`, the CLI `data-source.ts`
 * and the integration `test-data-source.ts`) only tells the *driver* to read and write DATETIME
 * strings as UTC — it never issues `SET time_zone`, so the *session* keeps whatever the server
 * defaults to. On a host whose MySQL runs in a non-UTC zone (a developer box in `Asia/Seoul`, a
 * Homebrew MySQL with `time_zone = SYSTEM`) the driver then parses a value the server rendered in
 * local time as if it were UTC, shifting every `createdAt` / `updatedAt` / `confirmedAt` the API
 * and webhooks return by the UTC offset and making `LONG_PENDING` fire on freshly-created
 * Operations (검증 문제 1 · 문제 4 / D4·D5).
 *
 * Forcing the session to `+00:00` makes a KST-hosted MySQL behave byte-for-byte like the
 * `mysql:8.4` container in `docker-compose.yml` (which already runs UTC), so the integration suite
 * passes in both zones. `+00:00` is a fixed offset, so it works even when the server's named
 * time-zone tables were never loaded (`SET time_zone = 'UTC'` fails there with ER_UNKNOWN_TIME_ZONE).
 *
 * Call this once, right after `DataSource.initialize()`.
 */
export async function enforceUtcSessionTimezone(dataSource: DataSource): Promise<void> {
  const SET_UTC = "SET SESSION time_zone = '+00:00'";
  const driver = dataSource.driver as unknown as {
    pool?: { on?: (event: string, listener: (connection: unknown) => void) => void };
  };
  const pool = driver.pool;

  // Every *future* physical connection the pool opens: mysql2 emits 'connection' synchronously,
  // before the connection is handed to a caller, so the SET has landed by the time it runs a query.
  pool?.on?.('connection', (connection) => {
    (connection as { query: (sql: string) => void }).query(SET_UTC);
  });

  // The connection(s) already open when we get here (initialize() opens one to verify credentials
  // and hands it back to the pool without the listener having seen it). Firing poolSize queries
  // concurrently forces the pool to warm every slot; running SET on an already-pinned connection
  // is a harmless no-op.
  const poolSize = (dataSource.options as { poolSize?: number }).poolSize ?? 10;
  await Promise.all(Array.from({ length: Math.max(1, poolSize) }, () => dataSource.query(SET_UTC)));
}
