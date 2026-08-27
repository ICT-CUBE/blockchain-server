import { Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';

import type { TransferApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import {
  OperationIntakeService,
  type AcceptApprovedMutationResult,
} from '../../../shared/idempotency/operation-intake.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { WalletService } from '../../wallet/application/wallet.service';
import type { TransferRequestBody } from './transfer-request.schema';

/**
 * TASK-08 §5: mirrors Mint's "never trust a raw address claim" pattern for both sides of a trade —
 * seller and buyer custodial wallets are looked up on file, and the approval JWT's `from`/`to` must
 * agree with what's found. Rejects a self-trade, a token that isn't currently owned by the claimed
 * seller, and (like Mint) does a best-effort accept-time owner check ahead of the mandatory
 * submit-time one in `TransferWorker`.
 */
@Injectable()
export class TransferApplication {
  private readonly logger = new Logger(TransferApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
  ) {}

  async accept(
    body: TransferRequestBody,
    approval: TransferApprovalClaims,
  ): Promise<AcceptApprovedMutationResult> {
    if (
      approval.tokenId !== body.tokenId ||
      approval.tradeId !== body.tradeId ||
      approval.sellerUserId !== body.sellerUserId ||
      approval.buyerUserId !== body.buyerUserId
    ) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    if (body.sellerUserId === body.buyerUserId) {
      throw new ApiError('TRANSFER_SELF_TRADE', 'sellerUserId and buyerUserId must be different users', 409);
    }

    const sellerWallet = await this.walletService.findByUserId(body.sellerUserId);
    if (!sellerWallet) {
      throw new ApiError(
        'WALLET_NOT_FOUND',
        `No custodial wallet on file for userId ${body.sellerUserId}`,
        404,
      );
    }
    const buyerWallet = await this.walletService.findByUserId(body.buyerUserId);
    if (!buyerWallet) {
      throw new ApiError(
        'WALLET_NOT_FOUND',
        `No custodial wallet on file for userId ${body.buyerUserId}`,
        404,
      );
    }

    const resolvedFrom = getAddress(sellerWallet.address);
    const resolvedTo = getAddress(buyerWallet.address);
    if (resolvedFrom !== getAddress(approval.from)) {
      throw new ApiError(
        'APPROVAL_FROM_MISMATCH',
        'Approval token "from" does not match the seller custodial wallet on file',
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
    if (resolvedFrom === resolvedTo) {
      throw new ApiError('TRANSFER_SELF_TRADE', 'Seller and buyer resolve to the same custodial wallet', 409);
    }

    // Best-effort — see MintApplication's identical reasoning: the mandatory re-check is
    // TransferWorker's, right before it would actually submit `authorizedTransfer`. `undefined`
    // means "RPC unavailable, unknown" and must not block acceptance; only a definitive answer
    // (confirmed not-minted, or confirmed owned by neither party) rejects here.
    const ownerCheck = await this.tryReadOwner(body.tokenId);
    if (ownerCheck.status === 'known') {
      if (ownerCheck.owner === null) {
        throw new ApiError('TRANSFER_TOKEN_NOT_MINTED', `tokenId ${body.tokenId} has not been minted`, 409);
      }
      const owner = getAddress(ownerCheck.owner);
      if (owner !== resolvedFrom && owner !== resolvedTo) {
        throw new ApiError(
          'TRANSFER_OWNER_MISMATCH',
          `tokenId ${body.tokenId} is not currently owned by the claimed seller`,
          409,
        );
      }
    }

    const validCommandHash = computeValidCommandHash({
      operation: OperationType.TRANSFER,
      tokenId: body.tokenId,
      tradeId: body.tradeId,
      sellerUserId: body.sellerUserId,
      buyerUserId: body.buyerUserId,
      from: resolvedFrom,
      to: resolvedTo,
    });

    return this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.TRANSFER,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        fromAddress: resolvedFrom,
        toAddress: resolvedTo,
        metadata: { tradeId: body.tradeId },
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
