import jwt from 'jsonwebtoken';

export interface SignApprovalJwtInput {
  claims: Record<string, unknown>;
  secret: Buffer;
  issuer: string;
  audience: string;
  expiresInSeconds?: number;
}

/** Signs a test ARZONE approval JWT the same way Backend would — `claims` must already include
 * `jti`, `purpose`, `tokenId`, and whichever purpose-specific fields the schema in
 * `approval-jwt-claims.ts` requires; this helper only adds the envelope (`iss`/`aud`/`exp`). */
export function signApprovalJwt(input: SignApprovalJwtInput): string {
  return jwt.sign(input.claims, input.secret, {
    algorithm: 'HS256',
    issuer: input.issuer,
    audience: input.audience,
    expiresIn: input.expiresInSeconds ?? 1800,
  });
}
