import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { ALL_ENTITIES } from '../../src/shared/database/entities';

/**
 * Connects to a real MySQL for the integration suite. Requires `DATABASE_URL` in the environment
 * (e.g. from `docker compose up -d mysql` plus the connection string it documents) — these tests
 * are deliberately skipped-by-construction (they throw at `beforeAll`) rather than silently passing
 * against nothing if no DB is reachable. Schema comes from the already-applied migrations
 * (`npm run migration:run`), not `synchronize`, so this also proves the migrations are usable.
 */
export function createTestDataSource(): DataSource {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to run the integration suite. Start MySQL (see docker-compose.yml), ' +
        'run `npm run migration:run`, then set DATABASE_URL and re-run `npm run test:integration`.',
    );
  }

  return new DataSource({
    type: 'mysql',
    url: databaseUrl,
    entities: ALL_ENTITIES,
    synchronize: false,
  });
}
