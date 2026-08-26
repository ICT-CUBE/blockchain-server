import { getAddress } from 'ethers';
import { z } from 'zod';

/** Zod schema for an EVM address that both validates and EIP-55 checksum-normalizes the value,
 * so every address downstream of config loading is already in canonical form for DB/comparison. */
const evmAddress = z
  .string()
  .refine(
    (value) => {
      try {
        getAddress(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid EVM address' },
  )
  .transform((value) => getAddress(value));

/** Matches the `{chainId, proxyAddress, implementationAddress, abiVersion, deployedAt}` artifact
 * contract defined in TASK-01, written by `contracts/cube-nft/scripts/deploy.ts`. */
export const contractDeploymentSchema = z.object({
  chainId: z.number().int().positive(),
  proxyAddress: evmAddress,
  implementationAddress: evmAddress,
  abiVersion: z.string().min(1),
  deployedAt: z.string().datetime(),
});

export type ContractDeployment = z.infer<typeof contractDeploymentSchema>;
