import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppConfigService } from '../../config/app-config.service';
import type { OperationType } from '../../domain/operation-type.enum';
import { ApiError } from '../../http/api-error';
import type { RequestWithId } from '../../http/request-id.middleware';
import { ApprovalJwtVerificationError, verifyApprovalJwt } from './approval-jwt.verifier';
import type { ApprovalClaims } from './approval-jwt-claims';
import { REQUIRES_APPROVAL_KEY } from './requires-approval.decorator';

export interface RequestWithApproval extends RequestWithId {
  approval: ApprovalClaims;
}

const logger = new Logger('ApprovalJwtGuard');

/** Runs after `HmacGuard` on routes decorated with `@RequiresApproval(purpose)`. Extracts the
 * bearer token, verifies it, and rejects if the token's `purpose` claim doesn't match the route's
 * expected purpose (TASK-06 §11: "JWT 목적·주소 불일치"; the address cross-check itself is each
 * operation's Application, TASK-07~09 — this guard only proves the token is genuine, unexpired,
 * and for the right *kind* of operation). On success, attaches the narrowed claims to
 * `request.approval`. */
@Injectable()
export class ApprovalJwtGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedPurpose = this.reflector.get<OperationType | undefined>(
      REQUIRES_APPROVAL_KEY,
      context.getHandler(),
    );
    if (!expectedPurpose) {
      // Not a route that requires approval (wallet/read/metadata endpoints — HMAC only).
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithApproval>();
    const requestId = request.requestId;

    const authorizationHeader = request.header('Authorization');
    const token = authorizationHeader?.startsWith('Bearer ')
      ? authorizationHeader.slice('Bearer '.length)
      : undefined;
    if (!token) {
      logger.warn(`Approval JWT rejected: requestId=${requestId} result=missing_token`);
      throw new ApiError('APPROVAL_JWT_MISSING', 'Missing ARZONE approval token', 401);
    }

    let claims: ApprovalClaims;
    try {
      claims = verifyApprovalJwt(token, this.config.approvalJwt);
    } catch (error) {
      if (error instanceof ApprovalJwtVerificationError) {
        logger.warn(`Approval JWT rejected: requestId=${requestId} result=invalid_token`);
        throw new ApiError('APPROVAL_JWT_INVALID', 'Invalid or expired ARZONE approval token', 401);
      }
      throw error;
    }

    if (claims.purpose !== expectedPurpose) {
      logger.warn(
        `Approval JWT rejected: requestId=${requestId} result=purpose_mismatch expected=${expectedPurpose} actual=${claims.purpose}`,
      );
      throw new ApiError(
        'APPROVAL_JWT_PURPOSE_MISMATCH',
        'Approval token is not valid for this operation',
        403,
      );
    }

    request.approval = claims;
    logger.log(`Approval JWT verified: requestId=${requestId} purpose=${claims.purpose} jti=${claims.jti}`);
    return true;
  }
}
