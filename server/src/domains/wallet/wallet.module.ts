import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../shared/auth/hmac/hmac-auth.module';
import { AppConfigService } from '../../shared/config/app-config.service';
import { CUSTODIAL_WALLET_PORT, type CustodialWalletPort } from './application/custodial-wallet.port';
import { WalletService } from './application/wallet.service';
import { WalletController } from './http/wallet.controller';
import { WalletPersistenceModule } from './persistence/wallet-persistence.module';
import { FakeWeb3AuthAdapter } from './providers/fake-web3auth.adapter';
import { Web3AuthAdapter } from './providers/web3auth.adapter';

// `CUSTODIAL_WALLET_PROVIDER` (default "fake") selects the binding at boot. `WalletService` and
// everything above it depends only on `CustodialWalletPort`, never on which adapter is bound — see
// TASK-05 §4/§13. Whichever adapter is NOT selected is never constructed (in particular,
// `Web3AuthAdapter` never calls Web3Auth until something actually invokes it), so leaving
// CUSTODIAL_WALLET_PROVIDER=fake costs nothing even with real Web3Auth env vars also set.
@Module({
  imports: [HmacAuthModule, WalletPersistenceModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    FakeWeb3AuthAdapter,
    Web3AuthAdapter,
    {
      provide: CUSTODIAL_WALLET_PORT,
      inject: [AppConfigService, FakeWeb3AuthAdapter, Web3AuthAdapter],
      useFactory: (
        config: AppConfigService,
        fake: FakeWeb3AuthAdapter,
        web3auth: Web3AuthAdapter,
      ): CustodialWalletPort => (config.web3Auth.provider === 'web3auth' ? web3auth : fake),
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
