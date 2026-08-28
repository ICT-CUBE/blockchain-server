/**
 * `npm run test:amoy` → `npm run amoy:acceptance --workspace=server`
 *
 * TASK-15 / 검증 계획서 T15-02: the Amoy acceptance run — Mint → 5 confirmations → ownerOf →
 * authorizedTransfer (EOA consent) → 5 confirmations → ownerOf → tokenURI, against the deployed
 * `contracts/deployments/amoy.json`, producing the JSON report the plan requires (chainId, proxy/
 * implementation, every txHash, receipt status/block/hash, confirmations, events, ownerOf, metadata
 * URI, timestamps).
 *
 * Required environment (all BLOCKED-if-missing — a missing value is a hard failure, never a skip,
 * per 검증 계획서 §6 "skipped 또는 credential 부재는 성공이 아니다"):
 *   AMOY_RPC_URL_PRIMARY            JSON-RPC endpoint (Infura or a public Amoy RPC)
 *   MINT_SIGNER_PRIVATE_KEY         holds MINTER_ROLE on the deployed proxy, funded with POL
 *   RELAYER_SIGNER_PRIVATE_KEY      holds AUTHORIZED_TRANSFER_ROLE, funded with POL
 * Optional:
 *   AMOY_ACCEPTANCE_TOKEN_ID        tokenId to mint (default: random 1..10000 that is not yet minted)
 *   AMOY_ACCEPTANCE_REPORT_DIR      default `reports/`
 *   CUBE_NFT_DEPLOYMENTS_DIR        default `contracts/deployments`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { Contract, JsonRpcProvider, Wallet, type TransactionReceipt } from 'ethers';

import {
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
  ownerConsentDomain,
} from '../src/domains/transaction/signing/owner-consent';

const REPO_ROOT = path.join(__dirname, '..', '..');
if (existsSync(path.join(REPO_ROOT, '.env'))) {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });
}

const REQUIRED_CONFIRMATIONS = 5;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`BLOCKED: ${name} is not set — Amoy acceptance cannot run without it`);
  }
  return value;
}

interface StepEvidence {
  step: string;
  txHash: string;
  receiptStatus: number | null;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  events: { name: string; args: Record<string, string> }[];
  ownerOfAfter: string;
  at: string;
}

async function waitForConfirmations(provider: JsonRpcProvider, txHash: string): Promise<{ receipt: TransactionReceipt; confirmations: number }> {
  const receipt = await provider.waitForTransaction(txHash, REQUIRED_CONFIRMATIONS, 10 * 60 * 1000);
  if (!receipt) {
    throw new Error(`no receipt for ${txHash} within 10 minutes`);
  }
  const latest = await provider.getBlockNumber();
  return { receipt, confirmations: latest - receipt.blockNumber + 1 };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const rpcUrl = requireEnv('AMOY_RPC_URL_PRIMARY');
  const minter = new Wallet(requireEnv('MINT_SIGNER_PRIVATE_KEY'));
  const relayer = new Wallet(requireEnv('RELAYER_SIGNER_PRIVATE_KEY'));

  const deploymentsDir = process.env.CUBE_NFT_DEPLOYMENTS_DIR ?? path.join(REPO_ROOT, 'contracts', 'deployments');
  const deploymentFile = path.join(deploymentsDir, 'amoy.json');
  if (!existsSync(deploymentFile)) {
    throw new Error(`BLOCKED: ${deploymentFile} not found — deploy first with \`npm run deploy:amoy --workspace=contracts/cube-nft\``);
  }
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8')) as {
    chainId: number;
    proxyAddress: string;
    implementationAddress: string;
    abiVersion: string;
    deployedAt: string;
  };
  const abi = JSON.parse(readFileSync(path.join(deploymentsDir, 'CubeNFT.abi.json'), 'utf8')) as never;

  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== deployment.chainId) {
    throw new Error(`RPC chainId ${network.chainId} != deployment chainId ${deployment.chainId}`);
  }

  const cubeAsMinter = new Contract(deployment.proxyAddress, abi, minter.connect(provider));
  const cubeAsRelayer = new Contract(deployment.proxyAddress, abi, relayer.connect(provider));
  const cubeRead = new Contract(deployment.proxyAddress, abi, provider);

  const balances = {
    minter: (await provider.getBalance(minter.address)).toString(),
    relayer: (await provider.getBalance(relayer.address)).toString(),
  };
  if (balances.minter === '0' || balances.relayer === '0') {
    throw new Error(`BLOCKED: signer balance is 0 POL (minter=${balances.minter}, relayer=${balances.relayer})`);
  }

  // Test subjects: two fresh EOAs (recipient A, then A → B via authorizedTransfer with A's consent).
  const userA = Wallet.createRandom();
  const userB = Wallet.createRandom();

  let tokenId = Number(process.env.AMOY_ACCEPTANCE_TOKEN_ID ?? 0);
  if (!tokenId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = Math.floor(Math.random() * 10000) + 1;
      if (!(await cubeRead.getFunction('exists')(candidate))) {
        tokenId = candidate;
        break;
      }
    }
  }
  if (!tokenId) {
    throw new Error('could not find an unminted tokenId');
  }
  const tokenUri = `ipfs://amoy-acceptance/${tokenId}.json`;
  const steps: StepEvidence[] = [];

  // 1) Mint
  const mintTx = await cubeAsMinter.getFunction('mintTo')(userA.address, tokenId, tokenUri);
  const mint = await waitForConfirmations(provider, mintTx.hash);
  steps.push({
    step: 'MINT',
    txHash: mintTx.hash,
    receiptStatus: mint.receipt.status,
    blockNumber: mint.receipt.blockNumber,
    blockHash: mint.receipt.blockHash,
    confirmations: mint.confirmations,
    events: decodeEvents(cubeRead, mint.receipt),
    ownerOfAfter: await cubeRead.getFunction('ownerOf')(tokenId),
    at: new Date().toISOString(),
  });

  // 2) Transfer A → B with A's EIP-712 consent, submitted by the relayer
  const nonce = await cubeRead.getFunction('consentNonce')(tokenId);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const consent = {
    tokenId,
    currentOwner: userA.address,
    from: userA.address,
    to: userB.address,
    purpose: OwnerConsentPurpose.TRANSFER,
    nonce,
    deadline,
  };
  const signature = await userA.signTypedData(
    ownerConsentDomain(deployment.chainId, deployment.proxyAddress),
    OWNER_CONSENT_TYPES,
    consent,
  );
  const transferTx = await cubeAsRelayer.getFunction('authorizedTransfer')(
    [consent.tokenId, consent.currentOwner, consent.from, consent.to, consent.purpose, consent.nonce, consent.deadline],
    signature,
  );
  const transfer = await waitForConfirmations(provider, transferTx.hash);
  steps.push({
    step: 'TRANSFER',
    txHash: transferTx.hash,
    receiptStatus: transfer.receipt.status,
    blockNumber: transfer.receipt.blockNumber,
    blockHash: transfer.receipt.blockHash,
    confirmations: transfer.confirmations,
    events: decodeEvents(cubeRead, transfer.receipt),
    ownerOfAfter: await cubeRead.getFunction('ownerOf')(tokenId),
    at: new Date().toISOString(),
  });

  const finalOwner = (await cubeRead.getFunction('ownerOf')(tokenId)) as string;
  const passed =
    steps.every((s) => s.receiptStatus === 1 && s.confirmations >= REQUIRED_CONFIRMATIONS) &&
    finalOwner.toLowerCase() === userB.address.toLowerCase();

  const report = {
    result: passed ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    network: { chainId: deployment.chainId, rpcHost: new URL(rpcUrl).host },
    deployment,
    signers: { minter: minter.address, relayer: relayer.address, balancesWeiAtStart: balances },
    subjects: { userA: userA.address, userB: userB.address, tokenId, tokenUri },
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    steps,
    final: { ownerOf: finalOwner, tokenURI: await cubeRead.getFunction('tokenURI')(tokenId) },
  };

  const reportDir = process.env.AMOY_ACCEPTANCE_REPORT_DIR ?? path.join(REPO_ROOT, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `amoy-acceptance-${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, reportFile, tokenId, finalOwner }, null, 2));
  if (!passed) {
    process.exitCode = 1;
  }
}

function decodeEvents(contract: Contract, receipt: TransactionReceipt): { name: string; args: Record<string, string> }[] {
  const out: { name: string; args: Record<string, string> }[] = [];
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) {
        const args: Record<string, string> = {};
        parsed.fragment.inputs.forEach((input, i) => {
          args[input.name] = String(parsed.args[i]);
        });
        out.push({ name: parsed.name, args });
      }
    } catch {
      // not one of ours
    }
  }
  return out;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
