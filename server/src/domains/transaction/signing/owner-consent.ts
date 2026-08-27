import type { TypedDataDomain, TypedDataField } from 'ethers';
import { Interface } from 'ethers';

/** Must match exactly what `CubeNFT.initialize()` passed to `__EIP712_init(name_, "1")` — see
 * `deploy.ts`'s `CONTRACT_NAME_TOKEN`. Not env-configurable: changing either value would make every
 * `OwnerConsent` signature this server produces fail verification on-chain, so these are load-bearing
 * constants tied to the deployed contract, not a runtime setting. */
export const CUBE_NFT_EIP712_DOMAIN_NAME = 'ARZONE CUBE NFT';
export const CUBE_NFT_EIP712_DOMAIN_VERSION = '1';

/** Mirrors `CubeNFT.sol`'s `OwnerConsent` struct and `PURPOSE_*` constants exactly — used by every
 * domain that submits an `authorizedTransfer` (TASK-08 Transfer, TASK-09 Withdrawal/Reentry/
 * External-Resale), all of which share one on-chain entry point and one consent shape. */
export const OWNER_CONSENT_TYPES: Record<string, TypedDataField[]> = {
  OwnerConsent: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'currentOwner', type: 'address' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'purpose', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export enum OwnerConsentPurpose {
  TRANSFER = 1,
  WITHDRAWAL = 2,
  REENTRY = 3,
  EXTERNAL_RESALE = 4,
}

export interface OwnerConsent {
  tokenId: number;
  currentOwner: string;
  from: string;
  to: string;
  purpose: OwnerConsentPurpose;
  nonce: bigint;
  deadline: bigint;
}

export function ownerConsentDomain(chainId: number, verifyingContract: string): TypedDataDomain {
  return {
    name: CUBE_NFT_EIP712_DOMAIN_NAME,
    version: CUBE_NFT_EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

export const AUTHORIZED_TRANSFER_INTERFACE = new Interface([
  'function authorizedTransfer((uint256 tokenId, address currentOwner, address from, address to, uint8 purpose, uint256 nonce, uint256 deadline) consent, bytes ownerSignature) external',
]);

export function encodeAuthorizedTransfer(consent: OwnerConsent, ownerSignature: string): string {
  return AUTHORIZED_TRANSFER_INTERFACE.encodeFunctionData('authorizedTransfer', [
    [
      consent.tokenId,
      consent.currentOwner,
      consent.from,
      consent.to,
      consent.purpose,
      consent.nonce,
      consent.deadline,
    ],
    ownerSignature,
  ]);
}
