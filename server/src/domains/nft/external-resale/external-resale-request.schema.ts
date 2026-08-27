import { z } from 'zod';

import { evmAddressSchema } from '../../../shared/domain/evm-address.schema';

/** `consentNonce`/`consentDeadline`/`externalSignature` come from a prior
 * `POST /internal/v1/external-consent-challenges` call and the external seller's own signature
 * over it — see `ReentryRequestBody`'s identical note. */
export const externalResaleRequestBodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  tradeId: z.string().min(1),
  buyerUserId: z.string().min(1),
  tokenId: z.number().int().min(1).max(10000),
  externalSellerAddress: evmAddressSchema,
  consentNonce: z.string().regex(/^\d+$/, 'must be a decimal integer string'),
  consentDeadline: z.string().regex(/^\d+$/, 'must be a decimal integer string'),
  externalSignature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'must be a hex-encoded signature'),
});

export type ExternalResaleRequestBody = z.infer<typeof externalResaleRequestBodySchema>;
