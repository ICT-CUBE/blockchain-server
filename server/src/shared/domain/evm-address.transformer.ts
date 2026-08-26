import { getAddress } from 'ethers';
import type { ValueTransformer } from 'typeorm';

/** TypeORM column transformer that EIP-55 checksum-normalizes an EVM address on every write, so
 * comparisons and unique constraints in the DB always operate on one canonical casing
 * (TASK-04/06 §4 공통 변경 사항: "EVM 주소 checksum 정규화, DB 비교는 정규화 값 사용"). Throws on an
 * invalid address rather than silently storing garbage. */
export const evmAddressTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return getAddress(value);
  },
  from(value: string | null): string | null {
    return value;
  },
};
