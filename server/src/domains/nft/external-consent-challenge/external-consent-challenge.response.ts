import type { TypedDataDomain, TypedDataField } from 'ethers';

export interface OwnerConsentMessage {
  tokenId: number;
  currentOwner: string;
  from: string;
  to: string;
  purpose: number;
  nonce: string;
  deadline: string;
}

/** Everything an external wallet's UI needs to present an EIP-712 signing prompt for a Reentry or
 * External-Resale consent — the exact `domain`/`types`/`message` triple that must be signed
 * unmodified, `ethers.Signer.signTypedData(domain, types, message)`-shaped so a frontend can pass
 * this response straight through. */
export interface ExternalConsentChallengeResponse {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  message: OwnerConsentMessage;
}
