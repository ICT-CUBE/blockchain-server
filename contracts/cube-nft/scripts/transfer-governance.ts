/**
 * Deploys a 48-hour `TimelockController` and transfers CubeNFT's `DEFAULT_ADMIN_ROLE` and
 * `UPGRADER_ROLE` to it, following the plan's risk mitigation order: grant to the Timelock, verify
 * the grant landed, only then renounce from the original EOA admin (TASK-03 §12: "grant→검증→
 * renounce 순서"). `PAUSER_ROLE` (the Emergency Pauser) is intentionally left untouched — it stays
 * on a dedicated address for immediate `pause()`, never behind the 48h delay.
 *
 * Safe usage:
 *   GOVERNANCE_TARGET=rehearsal  (default) — runs against local/Amoy for a dry run; the strict
 *     Mainnet config validator is skipped so a rehearsal on Amoy is not blocked.
 *   GOVERNANCE_TARGET=mainnet — enforces `assertValidGovernanceConfig`: the Timelock delay must be
 *     exactly 48h, and refuses to run at all unless `networkName` is itself Mainnet-track. This
 *     repo does not define a live "mainnet" Hardhat network yet (TASK-15 §14: Mainnet deployment is
 *     a separate, later approval), so `mainnet` mode is present for when that network exists but is
 *     not expected to actually execute here.
 *
 * Required env:
 *   CUBE_NFT_PROXY_ADDRESS               — the already-deployed CubeNFT proxy to govern.
 *   CUBE_NFT_TIMELOCK_PROPOSER_ADDRESSES — comma-separated; in production this is the single
 *                                          deployed Safe address, not a list of individual EOAs.
 * Optional env:
 *   CUBE_NFT_TIMELOCK_EXECUTOR_ADDRESSES — defaults to the proposer addresses.
 *   CUBE_NFT_TIMELOCK_MIN_DELAY_SECONDS  — defaults to 172800 (48h).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { network } from "hardhat";

import { assertValidGovernanceConfig, MAINNET_TIMELOCK_DELAY_SECONDS } from "../src/governance-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_DIR = path.resolve(__dirname, "..", "..", "deployments");

const UPGRADER_ROLE_LABEL = "UPGRADER_ROLE";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAddressList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const governanceTarget = process.env.GOVERNANCE_TARGET === "mainnet" ? "mainnet" : "rehearsal";
  const minDelaySeconds = Number(process.env.CUBE_NFT_TIMELOCK_MIN_DELAY_SECONDS ?? MAINNET_TIMELOCK_DELAY_SECONDS);
  const proposers = parseAddressList(requiredEnv("CUBE_NFT_TIMELOCK_PROPOSER_ADDRESSES"));
  const executors = process.env.CUBE_NFT_TIMELOCK_EXECUTOR_ADDRESSES
    ? parseAddressList(process.env.CUBE_NFT_TIMELOCK_EXECUTOR_ADDRESSES)
    : proposers;
  const proxyAddress = requiredEnv("CUBE_NFT_PROXY_ADDRESS");

  if (governanceTarget === "mainnet") {
    assertValidGovernanceConfig({
      networkName: connection.networkName,
      adminIsContract: true, // the Timelock we are about to deploy and grant the role to
      minDelaySeconds,
    });
  }

  console.log(`Deploying TimelockController (minDelay=${minDelaySeconds}s) on "${connection.networkName}"`);
  const TimelockFactory = await ethers.getContractFactory("GovernanceTimelock");
  // No standing TIMELOCK_ADMIN_ROLE holder (zero address): once deployed, only the Timelock's own
  // scheduled/executed calls can manage its roles, exactly like CubeNFT itself post-transfer.
  const timelock = await TimelockFactory.deploy(minDelaySeconds, proposers, executors, ethers.ZeroAddress);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("TimelockController deployed:", timelockAddress);

  const [admin] = await ethers.getSigners();
  const cube = await ethers.getContractAt("CubeNFT", proxyAddress, admin);
  const upgraderRole: string = await cube.UPGRADER_ROLE();

  console.log("Granting DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to the Timelock...");
  await (await cube.grantRole(ethers.ZeroHash, timelockAddress)).wait();
  await (await cube.grantRole(upgraderRole, timelockAddress)).wait();

  const hasAdmin: boolean = await cube.hasRole(ethers.ZeroHash, timelockAddress);
  const hasUpgrader: boolean = await cube.hasRole(upgraderRole, timelockAddress);
  if (!hasAdmin || !hasUpgrader) {
    throw new Error(
      `Grant verification failed before renouncing anything (hasAdmin=${hasAdmin}, has${UPGRADER_ROLE_LABEL}=${hasUpgrader}). ` +
        "Refusing to renounce the original admin's roles.",
    );
  }
  console.log("Grant verified. Renouncing the original EOA admin's roles...");

  await (await cube.renounceRole(upgraderRole, admin.address)).wait();
  await (await cube.renounceRole(ethers.ZeroHash, admin.address)).wait();

  const adminStillPrivileged =
    (await cube.hasRole(ethers.ZeroHash, admin.address)) || (await cube.hasRole(upgraderRole, admin.address));
  if (adminStillPrivileged) {
    throw new Error("Renounce did not take effect — the original EOA admin still holds a governance role.");
  }

  if (!existsSync(DEPLOYMENTS_DIR)) {
    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  const artifact = {
    proxyAddress,
    timelockAddress,
    minDelaySeconds,
    proposers,
    executors,
    governanceTarget,
    transferredAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(DEPLOYMENTS_DIR, `${connection.networkName}.governance.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  console.log("Governance transfer complete:", artifact);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
