import { z } from 'zod';

import { evmAddressSchema } from '../../../shared/domain/evm-address.schema';

export const externalConsentChallengeRequestSchema = z.object({
  tokenId: z.number().int().min(1).max(10000),
  from: evmAddressSchema,
  to: evmAddressSchema,
  purpose: z.enum(['REENTRY', 'EXTERNAL_RESALE']),
});

export type ExternalConsentChallengeRequest = z.infer<typeof externalConsentChallengeRequestSchema>;
