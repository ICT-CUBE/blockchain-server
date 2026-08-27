/**
 * Pure validation for the environment-dependent governance rule in the plan: local/Amoy may use a
 * single EOA admin, but Mainnet must be governed by a contract (the 48h Timelock) with exactly a
 * 48-hour delay — never an EOA, never a different delay. Kept dependency-free and chain-independent
 * so it can run both inside deploy/governance scripts and in plain unit tests (no need to spin up a
 * real "mainnet" Hardhat network to exercise the rejection paths).
 */

export const MAINNET_TIMELOCK_DELAY_SECONDS = 48 * 60 * 60;

/** Network names treated as Mainnet-track for governance validation purposes. */
const MAINNET_NETWORK_NAMES = new Set(['mainnet', 'polygon']);

export interface GovernanceConfigInput {
  networkName: string;
  /** Whether the account that will hold DEFAULT_ADMIN_ROLE/UPGRADER_ROLE after this deployment
   * step is a contract (a deployed Timelock) rather than an externally-owned account. */
  adminIsContract: boolean;
  minDelaySeconds: number;
}

export class InvalidMainnetGovernanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMainnetGovernanceConfigError';
  }
}

export function isMainnetTrackNetwork(networkName: string): boolean {
  return MAINNET_NETWORK_NAMES.has(networkName);
}

/** Throws `InvalidMainnetGovernanceConfigError` if `input` describes a Mainnet-track deployment
 * with an EOA admin or a Timelock delay other than exactly 48 hours. Any non-Mainnet network is
 * always accepted — local/Amoy's single dev admin is an explicitly approved configuration. */
export function assertValidGovernanceConfig(input: GovernanceConfigInput): void {
  if (!isMainnetTrackNetwork(input.networkName)) {
    return;
  }

  if (!input.adminIsContract) {
    throw new InvalidMainnetGovernanceConfigError(
      `Mainnet-track network "${input.networkName}" requires a contract (Timelock) admin, not an EOA`,
    );
  }

  if (input.minDelaySeconds !== MAINNET_TIMELOCK_DELAY_SECONDS) {
    throw new InvalidMainnetGovernanceConfigError(
      `Mainnet-track network "${input.networkName}" requires a ${MAINNET_TIMELOCK_DELAY_SECONDS}s ` +
        `(48h) Timelock delay, got ${input.minDelaySeconds}s`,
    );
  }
}
