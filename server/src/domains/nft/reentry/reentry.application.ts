import { Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';

import type { ReentryApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
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
import type { ReentryRequestBody } from './reentry-request.schema';

/**
 * TASK-09 §5: Reentry moves a token from a user-controlled external address back into that same
 * user's custodial wallet. Unlike Withdrawal, ARZONE does not hold the external wallet's key, so
 * the consent signature must come from the external wallet itself (via
 * `POST /internal/v1/external-consent-challenges` + the wallet's own signing UI).
 *
 * 검증 D3: the signature is verified *here*, before any Operation or asset lock exists, by
 * dry-running the exact `authorizedTransfer` call from the relayer (`ConsentDryRunService`). An
 * invalid signature, stale nonce, expired deadline, wrong owner or paused contract is a stable
 * 403/409 and leaves no row behind; an unreachable RPC is a retryable 503, never an acceptance.
 * 검증 D8: the signature is stored encrypted, with only its hash in the clear.
 */
@Injectable()
export class ReentryApplication {
  private readonly logger = new Logger(ReentryApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly appConfig: AppConfigService,
    private readonly consentDryRun: ConsentDryRunService,
  ) {}

  async accept(
    body: ReentryRequestBody,
    approval: ReentryApprovalClaims,
  ): Promise<AcceptApprovedMutationResult> {
    if (approval.tokenId !== body.tokenId || approval.userId !== body.userId) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    const wallet = await this.walletService.findByUserId(body.userId);
    if (!wallet) {
      throw new ApiError('WALLET_NOT_FOUND', `No custodial wallet on file for userId ${body.userId}`, 404);
    }

    const resolvedFrom = getAddress(body.externalAddress);
    const resolvedTo = getAddress(wallet.address);
    if (resolvedFrom !== getAddress(approval.from)) {
      throw new ApiError(
        'APPROVAL_FROM_MISMATCH',
        'Approval token "from" does not match externalAddress',
        403,
      );
    }
    if (resolvedTo !== getAddress(approval.to)) {
      throw new ApiError(
        'APPROVAL_TO_MISMATCH',
        'Approval token "to" does not match the custodial wallet on file',
        403,
      );
    }

    const deadline = BigInt(body.consentDeadline);
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new ApiError('CONSENT_EXPIRED', 'The signed OwnerConsent deadline has already passed', 409);
    }

    // Owner check first for a more specific error than the dry-run's generic revert mapping.
    const ownerCheck = await this.tryReadOwner(body.tokenId);
    if (
      ownerCheck.status === 'known' &&
      (!ownerCheck.owner || getAddress(ownerCheck.owner) !== resolvedFrom)
    ) {
      throw new ApiError(
        'REENTRY_OWNER_MISMATCH',
        `tokenId ${body.tokenId} is not currently owned by ${resolvedFrom}`,
        409,
      );
    }

    const consent: OwnerConsent = {
      tokenId: body.tokenId,
      currentOwner: resolvedFrom,
      from: resolvedFrom,
      to: resolvedTo,
      purpose: OwnerConsentPurpose.REENTRY,
      nonce: BigInt(body.consentNonce),
      deadline,
    };
    await this.consentDryRun.verifyAuthorizedTransfer(consent, body.externalSignature);

    const signatureHash = hashExternalSignature(body.externalSignature);
    const validCommandHash = computeValidCommandHash({
      operation: OperationType.REENTRY,
      tokenId: body.tokenId,
      userId: body.userId,
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
        type: OperationType.REENTRY,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        fromAddress: resolvedFrom,
        toAddress: resolvedTo,
        metadata: { ...storedConsent },
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
