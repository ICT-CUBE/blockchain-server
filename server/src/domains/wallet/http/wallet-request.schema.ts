import { z } from 'zod';

export const prepareWalletRequestSchema = z.object({
  userId: z.string().min(1),
});

export type PrepareWalletRequest = z.infer<typeof prepareWalletRequestSchema>;
