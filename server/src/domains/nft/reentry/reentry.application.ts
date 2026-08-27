import { Injectable, Logger } from '@nestjs/common';
import { getAddress, verifyTypedData } from 'ethers';

import type { ReentryApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import {
  OperationIntakeService,
  type AcceptApprovedMutationResult,
} from '../../../shared/idempotency/operation-intake.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import {
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
  ownerConsentDomain,
} from '../../transaction/signing/owner-consent';
import { WalletService } from '../../wallet/application/wallet.service';
import type { ReentryRequestBody } from './reentry-request.schema';

/**
 * TASK-09 §5: Reentry moves a token from a user-controlled external address back into that same
 * user's custodial wallet. Unlike Withdrawal, ARZONE does not hold the external wallet's key, so
 * the consent signature must come from the external wallet itself (via
 * `POST /internal/v1/external-consent-challenges` + the wallet's own signing UI) and is verified
 * here, not produced here.
 */
@Injectable()
export class ReentryApplication {
  private readonly logger = new Logger(ReentryApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly appConfig: AppConfigService,
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

    // Best-effort EOA recovery check — see MintApplication's identical reasoning for why a mismatch
    // here doesn't hard-reject: `verifyTypedData` only recovers EOA signatures, so a legitimate
    // ERC-1271 (smart-contract wallet) signer would always "fail" this check even though the
    // on-chain `authorizedTransfer` call (which uses `SignatureChecker`, covering both) would
    // accept it correctly. The schema's mandatory `externalSignature` field is what actually
    // enforces "외부 owner 서명 필수" (TASK-09 §11); this is a diagnostic aid, not the gate.
    this.warnIfObviouslyWrongSigner(body, resolvedFrom, resolvedTo, deadline);

    const ownerCheck = await this.tryReadOwner(body.tokenId);
    if (ownerCheck.status === 'known' && ownerCheck.owner && getAddress(ownerCheck.owner) !== resolvedFrom) {
      throw new ApiError(
        'REENTRY_OWNER_MISMATCH',
        `tokenId ${body.tokenId} is not currently owned by ${resolvedFrom}`,
        409,
      );
    }

    const validCommandHash = computeValidCommandHash({
      operation: OperationType.REENTRY,
      tokenId: body.tokenId,
      userId: body.userId,
      from: resolvedFrom,
      to: resolvedTo,
      consentNonce: body.consentNonce,
      consentDeadline: body.consentDeadline,
    });

    return this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.REENTRY,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        fromAddress: resolvedFrom,
        toAddress: resolvedTo,
        metadata: {
          consentNonce: body.consentNonce,
          consentDeadline: body.consentDeadline,
          externalSignature: body.externalSignature,
        },
      },
    });
  }

  private warnIfObviouslyWrongSigner(
    body: ReentryRequestBody,
    resolvedFrom: string,
    resolvedTo: string,
    deadline: bigint,
  ): void {
    try {
      const recovered = verifyTypedData(
        ownerConsentDomain(
          this.appConfig.cubeNft.deployment.chainId,
          this.appConfig.cubeNft.deployment.proxyAddress,
        ),
        OWNER_CONSENT_TYPES,
        {
          tokenId: body.tokenId,
          currentOwner: resolvedFrom,
          from: resolvedFrom,
          to: resolvedTo,
          purpose: OwnerConsentPurpose.REENTRY,
          nonce: BigInt(body.consentNonce),
          deadline,
        },
        body.externalSignature,
      );
      if (getAddress(recovered) !== resolvedFrom) {
        this.logger.warn(
          `Reentry externalSignature for tokenId ${body.tokenId} recovers to ${recovered}, not the expected ${resolvedFrom} — may be a valid ERC-1271 signature, or may be wrong; on-chain verification is authoritative`,
        );
      }
    } catch (error) {
      this.logger.warn(`Could not recover a signer from externalSignature: ${(error as Error).message}`);
    }
  }

  private async tryReadOwner(
    tokenId: number,
  ): Promise<{ status: 'known'; owner: string | null } | { status: 'unknown' }> {
    try {
      const owner = await this.cubeNftReader.ownerOf(tokenId);
      return { status: 'known', owner };
    } catch (error) {
      this.logger.warn(
        `Owner pre-check unavailable for tokenId ${tokenId}, proceeding without it: ${(error as Error).message}`,
      );
      return { status: 'unknown' };
    }
  }
}
