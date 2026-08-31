import 'reflect-metadata';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { ALL_ENTITIES } from './entities';
import { enforceUtcSessionTimezone } from './enforce-utc-session-timezone';

// Standalone entry point for the TypeORM CLI (`npm run migration:generate|run|revert`), which runs
// outside Nest's DI and so cannot go through AppConfigService. Loads `<blockchain-root>/.env`
// itself the same way `ConfigModule` does. Only `DATABASE_URL` is needed here — full env
// validation (CUBE_NFT_NETWORK etc.) is not relevant to running migrations.
loadDotenv({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}
const databaseSslEnabled = process.env.DATABASE_SSL_ENABLED === 'true';

// A single default export only — the TypeORM CLI's `loadDataSource` rejects a file with more than
// one exported DataSource-typed binding.
const dataSource = new DataSource({
  type: 'mysql',
  url: databaseUrl,
  ssl: databaseSslEnabled ? { rejectUnauthorized: true } : undefined,
  // Same UTC contract as the runtime `DatabaseModule` — see the note there (검증 D4/D5).
  timezone: 'Z',
  entities: ALL_ENTITIES,
  migrations: [path.join(__dirname, 'migrations', '*.{js,ts}')],
  synchronize: false,
});

// The CLI calls `.initialize()` itself; pin the session to UTC right after so migrations that read
// or compare timestamps behave the same on a non-UTC-hosted MySQL (검증 문제 1 / 문제 4).
const initialize = dataSource.initialize.bind(dataSource);
dataSource.initialize = async () => {
  const result = await initialize();
  await enforceUtcSessionTimezone(dataSource);
  return result;
};

export default dataSource;
