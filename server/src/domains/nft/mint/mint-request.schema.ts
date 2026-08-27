import { z } from 'zod';

/** `toAddress` is deliberately absent — the recipient is derived from `userId`'s custodial wallet
 * (TASK-06 §5: "Mint 요청에는 toAddress를 추가하지 않는다"), not accepted from the request body. */
export const mintRequestBodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  userId: z.string().min(1),
  cubeId: z.string().min(1),
  tokenId: z.number().int().min(1).max(10000),
});

export type MintRequestBody = z.infer<typeof mintRequestBodySchema>;
