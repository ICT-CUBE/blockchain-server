/**
 * Deploys the CubeNFT UUPS proxy to the network selected via `--network` and writes the shared
 * deployment artifact that both this package and the Blockchain Server read:
 * `contracts/deployments/<network>.json` = `{ chainId, proxyAddress, implementationAddress,
 * abiVersion, deployedAt }`, plus the ABI at `contracts/deployments/CubeNFT.abi.json`.
 *
 * Role addresses (admin/minter/relayer/pauser) are read from environment variables so the same
 * script works for local development and Amoy without hard-coded secrets. On the local simulated
 * network, missing role env vars fall back to Hardhat's deterministic dev signers for convenience.
 * TASK-03 replaces the local/Amoy `admin` role with the Safe-governed Timelock before Mainnet; this
 * script intentionally has no Mainnet-specific path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import hre, { network } from "hardhat";
import { upgrades } from "@openzeppelin/hardhat-upgrades";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
// `<blockchain-root>/contracts/deployments/`, one level above this package — shared between this
// package and the server, not private to contracts/cube-nft. See TASK-01.
const DEPLOYMENTS_DIR = path.resolve(PACKAGE_ROOT, "..", "deployments");

const CONTRACT_NAME_TOKEN = "ARZONE CUBE NFT";
const CONTRACT_SYMBOL = "CUBE";
const LOCAL_NETWORK_NAMES = new Set(["hardhatMainnet", "hardhatOp"]);

interface DeploymentArtifact {
  chainId: number;
  proxyAddress: string;
  implementationAddress: string;
  abiVersion: string;
  deployedAt: string;
}

async function resolveRoleAddress(
  envVar: string,
  isLocalNetwork: boolean,
  localFallback: () => Promise<string>,
): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return fromEnv;
  }
  if (isLocalNetwork) {
    return localFallback();
  }
  throw new Error(`Missing required environment variable: ${envVar}`);
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const upgradesApi = await upgrades(hre, connection);
  const isLocalNetwork = LOCAL_NETWORK_NAMES.has(connection.networkName);

  const signers = await ethers.getSigners();
  const admin = await resolveRoleAddress("CUBE_NFT_ADMIN_ADDRESS", isLocalNetwork, async () => signers[0].address);
  const minter = await resolveRoleAddress("CUBE_NFT_MINTER_ADDRESS", isLocalNetwork, async () => signers[1].address);
  const relayer = await resolveRoleAddress("CUBE_NFT_RELAYER_ADDRESS", isLocalNetwork, async () => signers[2].address);
  const pauser = await resolveRoleAddress("CUBE_NFT_PAUSER_ADDRESS", isLocalNetwork, async () => signers[3].address);

  console.log(`Deploying CubeNFT to network "${connection.networkName}"`);
  console.log({ admin, minter, relayer, pauser });

  const CubeNFTFactory = await ethers.getContractFactory("CubeNFT");
  const cube = await upgradesApi.deployProxy(
    CubeNFTFactory,
    [CONTRACT_NAME_TOKEN, CONTRACT_SYMBOL, admin, minter, relayer, pauser],
    { kind: "uups" },
  );
  await cube.waitForDeployment();

  const proxyAddress = await cube.getAddress();
  const implementationAddress = await upgradesApi.erc1967.getImplementationAddress(proxyAddress);
  const net = await ethers.provider.getNetwork();
  const contractsPackageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    version: string;
  };

  const artifact: DeploymentArtifact = {
    chainId: Number(net.chainId),
    proxyAddress,
    implementationAddress,
    abiVersion: contractsPackageJson.version,
    deployedAt: new Date().toISOString(),
  };

  if (!existsSync(DEPLOYMENTS_DIR)) {
    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
  writeFileSync(
    path.join(DEPLOYMENTS_DIR, `${connection.networkName}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  const compiledArtifact = JSON.parse(
    readFileSync(
      path.join(PACKAGE_ROOT, "artifacts", "contracts", "CubeNFT.sol", "CubeNFT.json"),
      "utf8",
    ),
  ) as { abi: unknown };
  writeFileSync(
    path.join(DEPLOYMENTS_DIR, "CubeNFT.abi.json"),
    `${JSON.stringify(compiledArtifact.abi, null, 2)}\n`,
  );

  console.log("Deployment artifact written:", artifact);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
