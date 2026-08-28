import { Injectable, Logger } from '@nestjs/common';
import { Interface, Wallet } from 'ethers';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { ApiError } from '../../../shared/http/api-error';
import { encodeAuthorizedTransfer, type OwnerConsent } from '../signing/owner-consent';
import { summarizeRpcError } from './rpc-error';
import { RpcService } from './rpc.service';

/** Stable API error for each `CubeNFT`/OpenZeppelin custom error `authorizedTransfer` can revert
 * with. Anything not listed maps to the generic `CONSENT_REJECTED_ON_CHAIN` (409) with the error
 * name in the message — still a deterministic rejection, still no Operation is created. */
const REVERT_MAPPING: Record<string, { code: string; status: number; message: string }> = {
  InvalidOwnerConsentSignature: {
    code: 'CONSENT_SIGNATURE_INVALID',
    status: 403,
    message: 'The OwnerConsent signature is not valid for the current owner of this token',
  },
  ConsentExpired: {
    code: 'CONSENT_EXPIRED',
    status: 409,
    message: 'The signed OwnerConsent deadline has already passed',
  },
  OwnerMismatch: {
    code: 'CONSENT_OWNER_MISMATCH',
    status: 409,
    message: 'The OwnerConsent currentOwner does not match the on-chain owner of this token',
  },
  InvalidConsentNonce: {
    code: 'CONSENT_NONCE_INVALID',
    status: 409,
    message: 'The OwnerConsent nonce is not the next expected consent nonce for this token',
  },
  InvalidConsentPurpose: {
    code: 'CONSENT_PURPOSE_INVALID',
    status: 400,
    message: 'The OwnerConsent purpose is not valid',
  },
  ERC721NonexistentToken: {
    code: 'TOKEN_NOT_MINTED',
    status: 409,
    message: 'This tokenId has not been minted',
  },
  ERC721InvalidReceiver: {
    code: 'RECIPIENT_CANNOT_RECEIVE',
    status: 409,
    message: 'The destination address cannot receive ERC-721 tokens',
  },
  EnforcedPause: {
    code: 'CONTRACT_PAUSED',
    status: 409,
    message: 'The CubeNFT contract is paused',
  },
  AccessControlUnauthorizedAccount: {
    code: 'RELAYER_NOT_AUTHORIZED',
    status: 503,
    message: 'The configured relayer signer does not hold AUTHORIZED_TRANSFER_ROLE',
  },
};

/**
 * 검증 D3: verifies an externally-signed `OwnerConsent` *before* an Operation or asset lock exists
 * by simulating the exact `authorizedTransfer` calldata the worker would submit, from the real
 * relayer address. One `eth_call` covers everything the contract itself checks — EOA **and**
 * ERC-1271 signatures (`SignatureChecker`), current owner, consent nonce, deadline, purpose, pause
 * state and the relayer's role — so there is no separate EOA-vs-contract-wallet policy to get wrong.
 *
 * Deterministic reverts become stable 4xx `ApiError`s; an RPC that cannot be reached becomes a
 * retryable 503, never an acceptance (an unverified consent must not be accepted).
 */
@Injectable()
export class ConsentDryRunService {
  private readonly logger = new Logger(ConsentDryRunService.name);
  private readonly contractInterface: Interface;
  private readonly relayerAddress: string;

  constructor(
    private readonly rpc: RpcService,
    private readonly appConfig: AppConfigService,
  ) {
    this.contractInterface = new Interface(appConfig.cubeNft.abi as never);
    this.relayerAddress = new Wallet(appConfig.submission.signers.relayerSignerPrivateKey).address;
  }

  /** Resolves when the consent would execute; throws `ApiError` otherwise. */
  async verifyAuthorizedTransfer(consent: OwnerConsent, ownerSignature: string): Promise<void> {
    const data = encodeAuthorizedTransfer(consent, ownerSignature);
    try {
      await this.rpc.simulateCall({
        from: this.relayerAddress,
        to: this.appConfig.cubeNft.deployment.proxyAddress,
        data,
      });
    } catch (error) {
      throw this.toApiError(error, consent.tokenId);
    }
  }

  private toApiError(error: unknown, tokenId: number): ApiError {
    const summary = summarizeRpcError(error);
    if (summary.class !== 'REVERT') {
      this.logger.warn(
        `Consent dry-run unavailable for tokenId ${tokenId}: ${summary.class}/${summary.code}: ${summary.reason}`,
      );
      return new ApiError(
        'CONSENT_VERIFICATION_UNAVAILABLE',
        'Could not verify the OwnerConsent against the chain right now; retry later',
        503,
      );
    }

    const revertName = this.decodeRevertName(error);
    const mapped = revertName ? REVERT_MAPPING[revertName] : undefined;
    if (mapped) {
      return new ApiError(mapped.code, mapped.message, mapped.status);
    }
    return new ApiError(
      'CONSENT_REJECTED_ON_CHAIN',
      `The OwnerConsent would be rejected by the contract${revertName ? ` (${revertName})` : ''}`,
      409,
    );
  }

  /** ethers puts the revert data on `error.data` (CALL_EXCEPTION) or nested in the JSON-RPC error. */
  private decodeRevertName(error: unknown): string | null {
    const candidates: unknown[] = [];
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      candidates.push(e.data);
      candidates.push((e.error as Record<string, unknown> | undefined)?.data);
      candidates.push(
        ((e.info as Record<string, unknown> | undefined)?.error as Record<string, unknown> | undefined)?.data,
      );
      candidates.push((e.revert as Record<string, unknown> | undefined)?.name);
    }
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/u.test(candidate)) {
        try {
          const parsed = this.contractInterface.parseError(candidate);
          if (parsed) {
            return parsed.name;
          }
        } catch {
          // not an error selector this ABI knows
        }
      } else if (typeof candidate === 'string' && candidate.length > 0 && !candidate.startsWith('0x')) {
        return candidate;
      }
    }
    return null;
  }
}
