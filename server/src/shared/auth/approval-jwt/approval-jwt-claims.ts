import { z } from 'zod';

import { evmAddressSchema } from '../../domain/evm-address.schema';
import { OperationType } from '../../domain/operation-type.enum';

/** Claims present on every approval JWT, before the purpose-specific fields are checked
 * (TASK-06 §5: "공통·업무 claim 단계 분리"). `purpose` reuses `OperationType` — an approval JWT is
 * only ever issued for one of the five NFT-ownership-changing operations, never MINT-adjacent
 * lookups (those use HMAC only). */
export const approvalCommonClaimsSchema = z.object({
  jti: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
  purpose: z.enum(OperationType),
  tokenId: z.number().int().positive(),
});

export type ApprovalCommonClaims = z.infer<typeof approvalCommonClaimsSchema>;

/** Mint's `to` is deliberately still present here — the JWT states which custodial address the
 * issuer *intends* to mint to — but per TASK-07 it is never trusted directly: the Application
 * looks up the wallet on file for `userId` and rejects if it does not match this claim. Approving
 * a mint by wallet lookup, not by trusting an arbitrary `to` in the token, is the whole point. */
export const mintApprovalClaimsSchema = approvalCommonClaimsSchema.extend({
  purpose: z.literal(OperationType.MINT),
  userId: z.string().min(1),
  cubeId: z.string().min(1),
  to: evmAddressSchema,
});

export const transferApprovalClaimsSchema = approvalCommonClaimsSchema.extend({
  purpose: z.literal(OperationType.TRANSFER),
  tradeId: z.string().min(1),
  sellerUserId: z.string().min(1),
  buyerUserId: z.string().min(1),
  from: evmAddressSchema,
  to: evmAddressSchema,
});

export const withdrawalApprovalClaimsSchema = approvalCommonClaimsSchema.extend({
  purpose: z.literal(OperationType.WITHDRAWAL),
  userId: z.string().min(1),
  from: evmAddressSchema,
  to: evmAddressSchema,
  /** Version identifier of the risk-disclosure text the user acknowledged before Backend issued
   * this approval (FR-027, "출금 고지 정보"). The Application persists this, it does not
   * re-render/verify the disclosure text itself. */
  riskAcknowledgementVersion: z.string().min(1),
});

export const reentryApprovalClaimsSchema = approvalCommonClaimsSchema.extend({
  purpose: z.literal(OperationType.REENTRY),
  userId: z.string().min(1),
  from: evmAddressSchema,
  to: evmAddressSchema,
});

export const externalResaleApprovalClaimsSchema = approvalCommonClaimsSchema.extend({
  purpose: z.literal(OperationType.EXTERNAL_RESALE),
  tradeId: z.string().min(1),
  buyerUserId: z.string().min(1),
  from: evmAddressSchema,
  to: evmAddressSchema,
});

export const approvalClaimsSchema = z.discriminatedUnion('purpose', [
  mintApprovalClaimsSchema,
  transferApprovalClaimsSchema,
  withdrawalApprovalClaimsSchema,
  reentryApprovalClaimsSchema,
  externalResaleApprovalClaimsSchema,
]);

export type ApprovalClaims = z.infer<typeof approvalClaimsSchema>;
export type MintApprovalClaims = z.infer<typeof mintApprovalClaimsSchema>;
export type TransferApprovalClaims = z.infer<typeof transferApprovalClaimsSchema>;
export type WithdrawalApprovalClaims = z.infer<typeof withdrawalApprovalClaimsSchema>;
export type ReentryApprovalClaims = z.infer<typeof reentryApprovalClaimsSchema>;
export type ExternalResaleApprovalClaims = z.infer<typeof externalResaleApprovalClaimsSchema>;
