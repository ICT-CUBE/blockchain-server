import { z } from 'zod';

import { evmAddressSchema } from '../../../shared/domain/evm-address.schema';

export const withdrawalRequestBodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  userId: z.string().min(1),
  tokenId: z.number().int().min(1).max(10000),
  externalAddress: evmAddressSchema,
  /** Version identifier of the risk-disclosure text the user acknowledged (FR-027) — persisted,
   * never re-rendered or re-verified by this service. */
  riskAcknowledgementVersion: z.string().min(1),
});

export type WithdrawalRequestBody = z.infer<typeof withdrawalRequestBodySchema>;
