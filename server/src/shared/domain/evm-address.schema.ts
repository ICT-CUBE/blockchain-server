import { getAddress } from 'ethers';
import { z } from 'zod';

/** Validates and EIP-55 checksum-normalizes an EVM address, for zod-validated DTOs/JWT claims —
 * the sibling of `evmAddressTransformer` for TypeORM columns. Rejects rather than silently
 * lowercasing/storing a malformed or wrong-checksum address. */
export const evmAddressSchema = z
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
