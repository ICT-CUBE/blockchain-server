import 'reflect-metadata';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { ALL_ENTITIES } from './entities';

// Standalone entry point for the TypeORM CLI (`npm run migration:generate|run|revert`), which runs
// outside Nest's DI and so cannot go through AppConfigService. Loads `<blockchain-root>/.env`
// itself the same way `ConfigModule` does. Only `DATABASE_URL` is needed here — full env
// validation (CUBE_NFT_NETWORK etc.) is not relevant to running migrations.
loadDotenv({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL');
}

// A single default export only — the TypeORM CLI's `loadDataSource` rejects a file with more than
// one exported DataSource-typed binding.
export default new DataSource({
  type: 'mysql',
  url: databaseUrl,
  entities: ALL_ENTITIES,
  migrations: [path.join(__dirname, 'migrations', '*.{js,ts}')],
  synchronize: false,
});
