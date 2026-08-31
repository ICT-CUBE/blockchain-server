import path from 'node:path';

import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../config/app-config.service';
import { ConfigModule } from '../config/config.module';
import { ALL_ENTITIES } from './entities';
import { enforceUtcSessionTimezone } from './enforce-utc-session-timezone';

/** Pins the connection pool to a UTC session as soon as the app is up — see
 * `enforce-utc-session-timezone.ts` for why `timezone: 'Z'` alone is not enough. */
@Injectable()
export class DatabaseTimezoneEnforcer implements OnApplicationBootstrap {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await enforceUtcSessionTimezone(this.dataSource);
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'mysql' as const,
        url: config.database.url,
        ssl: config.database.sslEnabled ? { rejectUnauthorized: true } : undefined,
        // Every TIMESTAMP(3) column is stored and read as UTC regardless of the host process's TZ.
        // Without this, mysql2 interprets DB values in the *local* zone (KST on a developer
        // machine), shifting every API/webhook/audit timestamp by the UTC offset and making
        // `LONG_PENDING` fire on every fresh Operation (검증 D4/D5). `DatabaseTimezoneEnforcer`
        // additionally pins the MySQL *session* to +00:00 so a non-UTC-hosted server agrees.
        timezone: 'Z',
        entities: ALL_ENTITIES,
        migrations: [path.join(__dirname, 'migrations', '*.js')],
        // Schema is owned by migrations, never by runtime auto-sync — see `npm run migration:*`.
        synchronize: false,
        migrationsRun: false,
        poolSize: config.database.poolMax,
        extra: {
          connectionLimit: config.database.poolMax,
        },
      }),
    }),
  ],
  providers: [DatabaseTimezoneEnforcer],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
