/**
 * Hand-maintained constants shared between the CubeNFT contract and any TypeScript caller
 * (contract tests, deploy scripts, and later the Blockchain Server). These must stay in exact sync
 * with `contracts/CubeNFT.sol` — they are not generated from the ABI because the EIP-712 type
 * string and purpose codes are part of the signed data contract, not just the function ABI.
 */

export const CUBE_NFT_MIN_TOKEN_ID = 1;
export const CUBE_NFT_MAX_TOKEN_ID = 10000;

export const OWNER_CONSENT_PURPOSE = {
  TRANSFER: 1,
  WITHDRAWAL: 2,
  REENTRY: 3,
  EXTERNAL_RESALE: 4,
} as const;

export type OwnerConsentPurpose = (typeof OWNER_CONSENT_PURPOSE)[keyof typeof OWNER_CONSENT_PURPOSE];

export interface OwnerConsent {
  tokenId: bigint;
  currentOwner: string;
  from: string;
  to: string;
  purpose: OwnerConsentPurpose;
  nonce: bigint;
  deadline: bigint;
}

/** EIP-712 type definition for `ethers.Signer.signTypedData` / `TypedDataEncoder`. */
export const OWNER_CONSENT_EIP712_TYPES = {
  OwnerConsent: [
    { name: "tokenId", type: "uint256" },
    { name: "currentOwner", type: "address" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "purpose", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 domain `version`. `name` is the deployed contract's ERC-721 `name()` and `verifyingContract`
 * / `chainId` come from the actual deployment, so those are not hard-coded here. */
export const CUBE_NFT_EIP712_DOMAIN_VERSION = "1";
