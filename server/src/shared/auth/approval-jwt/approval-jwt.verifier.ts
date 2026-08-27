import jwt from 'jsonwebtoken';

import type { ApprovalJwtConfig } from '../../config/app-config';
import { approvalClaimsSchema, type ApprovalClaims } from './approval-jwt-claims';

export class ApprovalJwtVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalJwtVerificationError';
  }
}

/**
 * Verifies an ARZONE approval JWT's signature, issuer/audience, and lifetime (HS256, a separate
 * key from the HMAC keys, at most 30 minutes — enforced twice: `exp` itself, plus `maxAge` in case
 * an issuer ever set a longer-lived `exp`), then validates the decoded payload against the
 * discriminated per-purpose claim schema. Throws `ApprovalJwtVerificationError` on any failure —
 * signature, expiry, or claim shape — the caller does not need to distinguish which.
 */
export function verifyApprovalJwt(token: string, config: ApprovalJwtConfig): ApprovalClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.secret, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
      maxAge: '30m',
      clockTolerance: 5,
    });
  } catch (error) {
    throw new ApprovalJwtVerificationError((error as Error).message);
  }

  const parsed = approvalClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ApprovalJwtVerificationError(`Approval JWT claims failed validation: ${detail}`);
  }
  return parsed.data;
}
