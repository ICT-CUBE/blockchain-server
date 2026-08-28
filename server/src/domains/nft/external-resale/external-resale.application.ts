import { Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';

import type { ExternalResaleApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import {
  OperationIntakeService,
  type AcceptApprovedMutationResult,
} from '../../../shared/idempotency/operation-intake.service';
import { ConsentDryRunService } from '../../transaction/rpc/consent-dry-run.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { OwnerConsentPurpose, type OwnerConsent } from '../../transaction/signing/owner-consent';
import { WalletService } from '../../wallet/application/wallet.service';
import {
  hashExternalSignature,
  sealExternalSignature,
  type StoredExternalConsent,
} from '../external-consent/stored-consent';
import type { ExternalResaleRequestBody } from './external-resale-request.schema';

/**
 * TASK-09 §5: External Resale moves a token from a user-controlled external address to the
 * *buyer's* custodial wallet (unlike Reentry, which returns to the same user) — otherwise the same
 * externally-signed consent pattern as Reentry, including 검증 D3's accept-time dry-run and
 * 검증 D8's encrypted signature storage.
 */
@Injectable()
export class ExternalResaleApplication {
  private readonly logger = new Logger(ExternalResaleApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly appConfig: AppConfigService,
    private readonly consentDryRun: ConsentDryRunService,
  ) {}

  async accept(
    body: ExternalResaleRequestBody,
    approval: ExternalResaleApprovalClaims,
  ): Promise<AcceptApprovedMutationResult> {
    if (
      approval.tokenId !== body.tokenId ||
      approval.tradeId !== body.tradeId ||
      approval.buyerUserId !== body.buyerUserId
    ) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    const buyerWallet = await this.walletService.findByUserId(body.buyerUserId);
    if (!buyerWallet) {
      throw new ApiError(
        'WALLET_NOT_FOUND',
        `No custodial wallet on file for userId ${body.buyerUserId}`,
        404,
      );
    }

    const resolvedFrom = getAddress(body.externalSellerAddress);
    const resolvedTo = getAddress(buyerWallet.address);
    if (resolvedFrom !== getAddress(approval.from)) {
      throw new ApiError(
        'APPROVAL_FROM_MISMATCH',
        'Approval token "from" does not match externalSellerAddress',
        403,
      );
    }
    if (resolvedTo !== getAddress(approval.to)) {
      throw new ApiError(
        'APPROVAL_TO_MISMATCH',
        'Approval token "to" does not match the buyer custodial wallet on file',
        403,
      );
    }

    const deadline = BigInt(body.consentDeadline);
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new ApiError('CONSENT_EXPIRED', 'The signed OwnerConsent deadline has already passed', 409);
    }

    const ownerCheck = await this.tryReadOwner(body.tokenId);
    if (
      ownerCheck.status === 'known' &&
      (!ownerCheck.owner || getAddress(ownerCheck.owner) !== resolvedFrom)
    ) {
      throw new ApiError(
        'EXTERNAL_RESALE_OWNER_MISMATCH',
        `tokenId ${body.tokenId} is not currently owned by ${resolvedFrom}`,
        409,
      );
    }

    const consent: OwnerConsent = {
      tokenId: body.tokenId,
      currentOwner: resolvedFrom,
      from: resolvedFrom,
      to: resolvedTo,
      purpose: OwnerConsentPurpose.EXTERNAL_RESALE,
      nonce: BigInt(body.consentNonce),
      deadline,
    };
    await this.consentDryRun.verifyAuthorizedTransfer(consent, body.externalSignature);

    const signatureHash = hashExternalSignature(body.externalSignature);
    const validCommandHash = computeValidCommandHash({
      operation: OperationType.EXTERNAL_RESALE,
      tokenId: body.tokenId,
      tradeId: body.tradeId,
      buyerUserId: body.buyerUserId,
      from: resolvedFrom,
      to: resolvedTo,
      consentNonce: body.consentNonce,
      consentDeadline: body.consentDeadline,
      externalSignatureHash: signatureHash,
    });

    const storedConsent: StoredExternalConsent = {
      consentNonce: body.consentNonce,
      consentDeadline: body.consentDeadline,
      externalSignatureCiphertext: sealExternalSignature(
        this.appConfig.submission.rawTxEncryptionKey,
        body.externalSignature,
      ),
      externalSignatureHash: signatureHash,
    };

    return this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.EXTERNAL_RESALE,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        fromAddress: resolvedFrom,
        toAddress: resolvedTo,
        metadata: { tradeId: body.tradeId, ...storedConsent },
      },
    });
  }

  private async tryReadOwner(
    tokenId: number,
  ): Promise<{ status: 'known'; owner: string | null } | { status: 'unknown' }> {
    try {
      const owner = await this.cubeNftReader.ownerOf(tokenId);
      return { status: 'known', owner };
    } catch (error) {
      this.logger.warn(
        `Owner pre-check unavailable for tokenId ${tokenId}, relying on the consent dry-run: ${(error as Error).message}`,
      );
      return { status: 'unknown' };
    }
  }
}
