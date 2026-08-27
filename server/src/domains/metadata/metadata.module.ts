import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../shared/auth/hmac/hmac-auth.module';
import { AppConfigService } from '../../shared/config/app-config.service';
import { MetadataService } from './application/metadata.service';
import { PINNING_PORT } from './application/pinning.port';
import { PRESERVATION_PORT } from './application/preservation.port';
import { MetadataController } from './http/metadata.controller';
import { MetadataPersistenceModule } from './persistence/metadata-persistence.module';
import { FakePinningAdapter } from './providers/fake-pinning.adapter';
import { FakePreservationAdapter } from './providers/fake-preservation.adapter';
import { NftStoragePreservationAdapter } from './providers/nft-storage-preservation.adapter';
import { PinataPinningAdapter } from './providers/pinata-pinning.adapter';

// `METADATA_PROVIDER` (default "fake") selects the binding at boot — same pattern as
// TASK-05's WalletModule. Whichever adapter isn't selected is never called, so leaving
// METADATA_PROVIDER=fake costs nothing even with real Pinata/NFT.Storage credentials also set.
@Module({
  imports: [HmacAuthModule, MetadataPersistenceModule],
  controllers: [MetadataController],
  providers: [
    MetadataService,
    FakePinningAdapter,
    PinataPinningAdapter,
    FakePreservationAdapter,
    NftStoragePreservationAdapter,
    {
      provide: PINNING_PORT,
      inject: [AppConfigService, FakePinningAdapter, PinataPinningAdapter],
      useFactory: (config: AppConfigService, fake: FakePinningAdapter, real: PinataPinningAdapter) =>
        config.metadata.provider === 'real' ? real : fake,
    },
    {
      provide: PRESERVATION_PORT,
      inject: [AppConfigService, FakePreservationAdapter, NftStoragePreservationAdapter],
      useFactory: (
        config: AppConfigService,
        fake: FakePreservationAdapter,
        real: NftStoragePreservationAdapter,
      ) => (config.metadata.provider === 'real' ? real : fake),
    },
  ],
  exports: [MetadataService],
})
export class MetadataModule {}
