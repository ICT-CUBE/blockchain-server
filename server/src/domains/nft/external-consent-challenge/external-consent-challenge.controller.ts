import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { ApiError } from '../../../shared/http/api-error';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import {
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
  ownerConsentDomain,
} from '../../transaction/signing/owner-consent';
import {
  externalConsentChallengeRequestSchema,
  type ExternalConsentChallengeRequest,
} from './external-consent-challenge.schema';
import type { ExternalConsentChallengeResponse } from './external-consent-challenge.response';

/** `POST /internal/v1/external-consent-challenges` — TASK-09 §7's "외부 서명용 typed-data challenge
 * 조회/생성 계약": returns the exact EIP-712 payload (with the *current* on-chain `consentNonce` and
 * a freshly-chosen `deadline`) an external wallet must sign to authorize a Reentry or
 * External-Resale. HMAC only — this reads chain state and mints a challenge, it doesn't mutate
 * anything (TASK-06 §4). */
@Controller('internal/v1/external-consent-challenges')
@UseGuards(HmacGuard)
export class ExternalConsentChallengeController {
  constructor(
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Post()
  @HttpCode(200)
  async create(
    @Body(new ZodValidationPipe(externalConsentChallengeRequestSchema)) body: ExternalConsentChallengeRequest,
  ): Promise<ExternalConsentChallengeResponse> {
    const actualOwner = await this.cubeNftReader.ownerOf(body.tokenId);
    if (!actualOwner || actualOwner.toLowerCase() !== body.from.toLowerCase()) {
      throw new ApiError(
        'EXTERNAL_CONSENT_OWNER_MISMATCH',
        `tokenId ${body.tokenId} is not currently owned by ${body.from}`,
        409,
      );
    }

    const nonce = await this.cubeNftReader.consentNonce(body.tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.appConfig.ownerConsent.deadlineSeconds);
    const purpose =
      body.purpose === 'REENTRY' ? OwnerConsentPurpose.REENTRY : OwnerConsentPurpose.EXTERNAL_RESALE;

    return {
      domain: ownerConsentDomain(
        this.appConfig.cubeNft.deployment.chainId,
        this.appConfig.cubeNft.deployment.proxyAddress,
      ),
      types: OWNER_CONSENT_TYPES,
      message: {
        tokenId: body.tokenId,
        currentOwner: body.from,
        from: body.from,
        to: body.to,
        purpose,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
    };
  }
}
