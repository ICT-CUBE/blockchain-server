import { z } from 'zod';

import { evmAddressSchema } from '../../../shared/domain/evm-address.schema';

/** `consentNonce`/`consentDeadline`/`externalSignature` come straight from a prior
 * `POST /internal/v1/external-consent-challenges` call's response and the external wallet's
 * signature over it — this service never re-derives them, since doing so would produce a
 * different message than what was actually signed. */
export const reentryRequestBodySchema = z.object({
  idempotencyKey: z.string().uuid(),
  userId: z.string().min(1),
  tokenId: z.number().int().min(1).max(10000),
  externalAddress: evmAddressSchema,
  consentNonce: z.string().regex(/^\d+$/, 'must be a decimal integer string'),
  consentDeadline: z.string().regex(/^\d+$/, 'must be a decimal integer string'),
  externalSignature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'must be a hex-encoded signature'),
});

export type ReentryRequestBody = z.infer<typeof reentryRequestBodySchema>;
