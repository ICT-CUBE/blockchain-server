import { Interface, JsonRpcProvider } from 'ethers';

const OWNER_OF = new Interface(['function ownerOf(uint256) view returns (address)']);

/**
 * A random tokenId in 1..9000 that is **not yet minted** on the chain at `rpcUrl`. Integration
 * suites used to pick a purely random id, which collides (`TokenAlreadyMinted`) on any long-lived
 * shared Hardhat node once a few hundred test mints have accumulated (검증 개선안 §7 격리 요건).
 */
export async function unmintedTokenId(rpcUrl: string, proxyAddress: string): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = Math.floor(Math.random() * 9000) + 1;
      try {
        await provider.call({ to: proxyAddress, data: OWNER_OF.encodeFunctionData('ownerOf', [candidate]) });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'CALL_EXCEPTION') {
          return candidate; // ERC721NonexistentToken → free
        }
        throw error;
      }
    }
    throw new Error('could not find an unminted tokenId in 50 attempts');
  } finally {
    provider.destroy();
  }
}
