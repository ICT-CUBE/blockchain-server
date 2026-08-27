import { Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';

import type { MintApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import {
  OperationIntakeService,
  type AcceptApprovedMutationResult,
} from '../../../shared/idempotency/operation-intake.service';
import { MetadataService } from '../../metadata/application/metadata.service';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { WalletService } from '../../wallet/application/wallet.service';
import type { MintRequestBody } from './mint-request.schema';

/**
 * TASK-07 §5: Mint acceptance never trusts the approval JWT's `to` directly — it resolves the
 * user's custodial wallet on file and requires the JWT to agree with it, then hashes the
 * *resolved* address (not the raw claim) into the idempotency command hash. A wallet lookup
 * failure or JWT/wallet mismatch is rejected before any Operation or asset lock is created.
 *
 * Also enforces TASK-13 §5's "전부 hot pin 완료되기 전... Mint를 접수하지 않는다": unlike the
 * best-effort owner pre-check below, metadata readiness is a local DB read (no external network
 * dependency, no partial-availability concern), so this is a hard gate, not best-effort.
 */
@Injectable()
export class MintApplication {
  private readonly logger = new Logger(MintApplication.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly operationIntake: OperationIntakeService,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly metadataService: MetadataService,
  ) {}

  async accept(body: MintRequestBody, approval: MintApprovalClaims): Promise<AcceptApprovedMutationResult> {
    if (
      approval.tokenId !== body.tokenId ||
      approval.userId !== body.userId ||
      approval.cubeId !== body.cubeId
    ) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    const wallet = await this.walletService.findByUserId(body.userId);
    if (!wallet) {
      throw new ApiError('WALLET_NOT_FOUND', `No custodial wallet on file for userId ${body.userId}`, 404);
    }

    const resolvedTo = getAddress(wallet.address);
    if (resolvedTo !== getAddress(approval.to)) {
      throw new ApiError(
        'APPROVAL_TO_MISMATCH',
        'Approval token "to" does not match the custodial wallet on file for this user',
        403,
      );
    }

    const metadataReady = await this.metadataService.isReady(body.tokenId);
    if (!metadataReady) {
      throw new ApiError(
        'METADATA_NOT_READY',
        `Metadata for tokenId ${body.tokenId} is not fully pinned yet — call POST /internal/v1/metadata first`,
        409,
      );
    }

    // Best-effort early rejection, not the authoritative gate: if the token is already minted to
    // someone else, flag that now rather than accepting a request doomed to conflict later. But an
    // RPC failure here must not block acceptance — the *mandatory* re-check is `MintWorker`'s, right
    // before it would actually submit a transaction ("제출 직전 owner 재검증", TASK-07 §12), which is
    // the real safety net regardless of whether this one could run. Already-minted-to-the-
    // *expected*-owner is deliberately NOT special-cased here — that idempotent-completion
    // classification happens once, in `MintWorker`, not duplicated across accept- and submit-time.
    const actualOwner = await this.tryReadOwner(body.tokenId);
    if (actualOwner && getAddress(actualOwner) !== resolvedTo) {
      throw new ApiError(
        'MINT_TOKEN_OWNER_CONFLICT',
        `tokenId ${body.tokenId} is already minted to a different owner`,
        409,
      );
    }

    const validCommandHash = computeValidCommandHash({
      operation: OperationType.MINT,
      tokenId: body.tokenId,
      userId: body.userId,
      cubeId: body.cubeId,
      resolvedTo,
    });

    return this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.MINT,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        toAddress: resolvedTo,
      },
    });
  }

  private async tryReadOwner(tokenId: number): Promise<string | null> {
    try {
      return await this.cubeNftReader.ownerOf(tokenId);
    } catch (error) {
      this.logger.warn(
        `Owner pre-check unavailable for tokenId ${tokenId}, proceeding without it: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
