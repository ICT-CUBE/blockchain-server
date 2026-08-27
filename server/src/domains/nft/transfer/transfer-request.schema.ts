import { z } from 'zod';

/** `from`/`to` are deliberately absent — both are derived from `sellerUserId`/`buyerUserId`'s
 * custodial wallets (TASK-08 §5), matching TASK-07's Mint "never trust a raw address claim
 * directly" pattern. */
export const transferRequestBodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  tradeId: z.string().min(1),
  sellerUserId: z.string().min(1),
  buyerUserId: z.string().min(1),
  tokenId: z.number().int().min(1).max(10000),
});

export type TransferRequestBody = z.infer<typeof transferRequestBodySchema>;
