import { Injectable, Logger } from '@nestjs/common';
import { getAddress, ZeroAddress } from 'ethers';

import type { WithdrawalApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import {
  OperationIntakeService,
  type AcceptApprovedMutationResult,
} from '../../../shared/idempotency/operation-intake.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { WalletService } from '../../wallet/application/wallet.service';
import type { WithdrawalRequestBody } from './withdrawal-request.schema';

/**
 * TASK-09 §5: Withdrawal moves a token from the user's own custodial wallet to an external
 * address the user controls. The current owner (custodial wallet) can consent on the server's
 * behalf — same mechanism as Transfer — since ARZONE already holds that wallet; no external
 * signature is needed here (unlike Reentry/External-Resale, where the *external* wallet must sign).
 */
@Injectable()
export class WithdrawalApplication {
  private readonly logger = new Logger(WithdrawalApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
  ) {}

  async accept(
    body: WithdrawalRequestBody,
    approval: WithdrawalApprovalClaims,
  ): Promise<AcceptApprovedMutationResult> {
    if (
      approval.tokenId !== body.tokenId ||
      approval.userId !== body.userId ||
      approval.riskAcknowledgementVersion !== body.riskAcknowledgementVersion
    ) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    if (getAddress(body.externalAddress) === ZeroAddress) {
      throw new ApiError('WITHDRAWAL_ZERO_ADDRESS', 'externalAddress must not be the zero address', 400);
    }

    const wallet = await this.walletService.findByUserId(body.userId);
    if (!wallet) {
      throw new ApiError('WALLET_NOT_FOUND', `No custodial wallet on file for userId ${body.userId}`, 404);
    }

    const resolvedFrom = getAddress(wallet.address);
    const resolvedTo = getAddress(body.externalAddress);
    if (resolvedFrom !== getAddress(approval.from)) {
      throw new ApiError(
        'APPROVAL_FROM_MISMATCH',
        'Approval token "from" does not match the custodial wallet on file',
        403,
      );
    }
    if (resolvedTo !== getAddress(approval.to)) {
      throw new ApiError('APPROVAL_TO_MISMATCH', 'Approval token "to" does not match externalAddress', 403);
    }

    const ownerCheck = await this.tryReadOwner(body.tokenId);
    if (ownerCheck.status === 'known' && ownerCheck.owner && getAddress(ownerCheck.owner) !== resolvedFrom) {
      throw new ApiError(
        'WITHDRAWAL_OWNER_MISMATCH',
        `tokenId ${body.tokenId} is not currently owned by userId ${body.userId}'s custodial wallet`,
        409,
      );
    }

    const validCommandHash = computeValidCommandHash({
      operation: OperationType.WITHDRAWAL,
      tokenId: body.tokenId,
      userId: body.userId,
      from: resolvedFrom,
      to: resolvedTo,
      riskAcknowledgementVersion: body.riskAcknowledgementVersion,
    });

    return this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.WITHDRAWAL,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        fromAddress: resolvedFrom,
        toAddress: resolvedTo,
        metadata: { riskAcknowledgementVersion: body.riskAcknowledgementVersion },
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
        `Owner pre-check unavailable for tokenId ${tokenId}, proceeding without it: ${(error as Error).message}`,
      );
      return { status: 'unknown' };
    }
  }
}
