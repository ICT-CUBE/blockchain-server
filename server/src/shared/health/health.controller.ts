import { Controller, Get } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';

interface HealthResponse {
  status: 'ok';
}

interface ReadinessResponse {
  status: 'ready';
  network: string;
  cubeNftProxyAddress: string;
}

@Controller()
export class HealthController {
  constructor(private readonly config: AppConfigService) {}

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
    };
  }
}
