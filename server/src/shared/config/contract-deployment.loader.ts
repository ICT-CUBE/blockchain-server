import { readFileSync } from 'node:fs';
import path from 'node:path';

import { contractDeploymentSchema, type ContractDeployment } from './contract-deployment.schema';

export interface LoadedContract {
  readonly deployment: ContractDeployment;
  readonly abi: readonly unknown[];
}

function defaultDeploymentsDir(): string {
  // `<blockchain-root>/contracts/deployments/`, shared between contracts/cube-nft and this server
  // (see TASK-01) — one level above the @cube-nft/contracts package itself.
  const contractsPackageJsonPath = require.resolve('@cube-nft/contracts/package.json');
  return path.join(path.dirname(contractsPackageJsonPath), '..', 'deployments');
}

function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${(error as Error).message}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

/** Reads and validates the shared CubeNFT deployment artifact (`<network>.json`) and its ABI
 * (`CubeNFT.abi.json`) written by `contracts/cube-nft/scripts/deploy.ts`. Throws — deliberately,
 * for fail-fast startup — on a missing file, malformed JSON, or a chainId/address that fails
 * `contractDeploymentSchema`. */
export function loadCubeNftContract(network: string, deploymentsDirOverride?: string): LoadedContract {
  const deploymentsDir = deploymentsDirOverride ?? defaultDeploymentsDir();

  const deploymentPath = path.join(deploymentsDir, `${network}.json`);
  const abiPath = path.join(deploymentsDir, 'CubeNFT.abi.json');

  const deployment = contractDeploymentSchema.parse(readJson(deploymentPath));

  const abiRaw = readJson(abiPath);
  if (!Array.isArray(abiRaw)) {
    throw new Error(`CubeNFT ABI at ${abiPath} must be a JSON array`);
  }

  return { deployment, abi: abiRaw };
}
