import { Controller, Get } from '@nestjs/common';

import { WalletService } from '../../domains/wallet/application/wallet.service';
import { AppConfigService } from '../config/app-config.service';

interface HealthResponse {
  status: 'ok';
}

interface ReadinessResponse {
  status: 'ready';
  network: string;
  cubeNftProxyAddress: string;
  /** False whenever the custodial wallet provider is the local fake adapter, not real Web3Auth
   * custody (TASK-05 §5: "credential 누락 시 readiness가 실제 integration 미준비를 표시한다"). */
  walletIntegrationReady: boolean;
  walletProvider: string;
}

@Controller()
export class HealthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly walletService: WalletService,
  ) {}

  /** Liveness only: process is up. Does not touch DB/RPC (added in later tasks). */
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: config loaded and the CubeNFT deployment artifact resolved successfully. */
  @Get('ready')
  ready(): ReadinessResponse {
    return {
      status: 'ready',
      network: this.config.network,
      cubeNftProxyAddress: this.config.cubeNft.deployment.proxyAddress,
      walletIntegrationReady: this.walletService.isIntegrationReady,
      walletProvider: this.walletService.providerName,
    };
  }
}
