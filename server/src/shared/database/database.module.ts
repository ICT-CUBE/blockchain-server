import path from 'node:path';

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppConfigService } from '../config/app-config.service';
import { ConfigModule } from '../config/config.module';
import { ALL_ENTITIES } from './entities';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'mysql' as const,
        url: config.database.url,
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
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
