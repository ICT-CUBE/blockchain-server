import { envSchema, LOCAL_NETWORK_NAMES, type Env } from './env.schema';
import { loadCubeNftContract, type LoadedContract } from './contract-deployment.loader';

/** Hardhat's well-known dev mnemonic ("test test test ... junk") accounts #1/#2 — the same fallback
 * `contracts/cube-nft/scripts/deploy.ts` uses locally for the minter/relayer roles. Public, non-
 * secret, and only ever used when `CUBE_NFT_NETWORK` is a local Hardhat network. */
const LOCAL_DEV_MINT_SIGNER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const LOCAL_DEV_RELAYER_SIGNER_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const LOCAL_DEV_RPC_URL_PRIMARY = 'http://127.0.0.1:8545';

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMin: number;
  readonly poolMax: number;
}

export interface HmacKeyConfig {
  readonly keyId: string;
  readonly secret: Buffer;
}

export interface HmacInboundConfig {
  readonly current: HmacKeyConfig;
  /** Set only during a 90-day key-rotation window; both keys are accepted while it is set. */
  readonly previous: HmacKeyConfig | null;
}

export interface ApprovalJwtConfig {
  readonly secret: Buffer;
  readonly issuer: string;
  readonly audience: string;
}

export interface Web3AuthConfig {
  readonly provider: 'fake' | 'web3auth';
  readonly clientId: string;
  readonly network: string;
  readonly chainId: number;
  readonly rpcTarget: string;
  readonly authConnectionId: string | null;
  readonly jwtSigningPrivateKey: string | null;
  readonly jwtSigningKeyId: string | null;
}

export interface TransactionRpcConfig {
  readonly primaryUrl: string;
  readonly backupUrl: string | null;
}

export interface TransactionSignersConfig {
  readonly mintSignerPrivateKey: string;
  readonly relayerSignerPrivateKey: string;
}

export interface SubmissionConfig {
  readonly rpc: TransactionRpcConfig;
  readonly signers: TransactionSignersConfig;
  /** Base64-decoded 32-byte AES-256-GCM key. */
  readonly rawTxEncryptionKey: Buffer;
  readonly pollIntervalMs: number;
  readonly rbfThresholdMs: number;
  readonly rbfMaxAttempts: number;
  readonly rbfFeeBumpPercent: number;
}

export interface ConfirmationConfig {
  readonly blocksRequired: number;
  readonly reconciliationPollIntervalMs: number;
  readonly reconciliationBatchSize: number;
}

export interface MintConfig {
  readonly metadataBaseUri: string;
}

export interface OwnerConsentConfig {
  readonly deadlineSeconds: number;
}

export interface HmacOutboundConfig {
  readonly keyId: string;
  readonly secret: Buffer;
}

export interface NotificationConfig {
  readonly callbackUrl: string;
  readonly hmacOutbound: HmacOutboundConfig;
  readonly timeoutMs: number;
  readonly maxAutoRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
}

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly network: string;
  readonly cubeNft: LoadedContract;
  readonly database: DatabaseConfig;
  readonly hmacInbound: HmacInboundConfig;
  readonly approvalJwt: ApprovalJwtConfig;
  readonly web3Auth: Web3AuthConfig;
  readonly submission: SubmissionConfig;
  readonly confirmation: ConfirmationConfig;
  readonly mint: MintConfig;
  readonly ownerConsent: OwnerConsentConfig;
  readonly notification: NotificationConfig;
}

/** Validates `env` against `envSchema` and loads the matching CubeNFT deployment artifact. Throws
 * on any missing/invalid value so callers get fail-fast startup rather than a partially-configured
 * app. Never logs or returns `database.url`, HMAC secrets, or the JWT secret verbatim. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);
  const cubeNft = loadCubeNftContract(parsedEnv.CUBE_NFT_NETWORK, parsedEnv.CUBE_NFT_DEPLOYMENTS_DIR);

  const isLocalNetwork = LOCAL_NETWORK_NAMES.has(parsedEnv.CUBE_NFT_NETWORK);

  const previousHmacKey: HmacKeyConfig | null =
    parsedEnv.HMAC_INBOUND_PREVIOUS_KEY_ID && parsedEnv.HMAC_INBOUND_PREVIOUS_KEY_SECRET
      ? {
          keyId: parsedEnv.HMAC_INBOUND_PREVIOUS_KEY_ID,
          secret: Buffer.from(parsedEnv.HMAC_INBOUND_PREVIOUS_KEY_SECRET, 'base64url'),
        }
      : null;

  return Object.freeze({
    nodeEnv: parsedEnv.NODE_ENV,
    port: parsedEnv.PORT,
    network: parsedEnv.CUBE_NFT_NETWORK,
    cubeNft,
    database: Object.freeze({
      url: parsedEnv.DATABASE_URL,
      poolMin: parsedEnv.DATABASE_POOL_MIN,
      poolMax: parsedEnv.DATABASE_POOL_MAX,
    }),
    hmacInbound: Object.freeze({
      current: Object.freeze({
        keyId: parsedEnv.HMAC_INBOUND_KEY_ID,
        secret: Buffer.from(parsedEnv.HMAC_INBOUND_KEY_SECRET, 'base64url'),
      }),
      previous: previousHmacKey ? Object.freeze(previousHmacKey) : null,
    }),
    approvalJwt: Object.freeze({
      secret: Buffer.from(parsedEnv.APPROVAL_JWT_SECRET, 'base64url'),
      issuer: parsedEnv.APPROVAL_JWT_ISSUER,
      audience: parsedEnv.APPROVAL_JWT_AUDIENCE,
    }),
    web3Auth: Object.freeze({
      provider: parsedEnv.CUSTODIAL_WALLET_PROVIDER,
      clientId: parsedEnv.WEB3AUTH_CLIENT_ID ?? '',
      network: parsedEnv.WEB3AUTH_NETWORK,
      chainId: parsedEnv.WEB3AUTH_CHAIN_ID,
      rpcTarget: parsedEnv.WEB3AUTH_RPC_TARGET ?? '',
      authConnectionId: parsedEnv.WEB3AUTH_AUTH_CONNECTION_ID ?? null,
      jwtSigningPrivateKey: parsedEnv.WEB3AUTH_JWT_SIGNING_PRIVATE_KEY ?? null,
      jwtSigningKeyId: parsedEnv.WEB3AUTH_JWT_SIGNING_KEY_ID ?? null,
    }),
    submission: Object.freeze({
      rpc: Object.freeze({
        primaryUrl:
          parsedEnv.TRANSACTION_RPC_URL_PRIMARY ?? (isLocalNetwork ? LOCAL_DEV_RPC_URL_PRIMARY : ''),
        backupUrl: parsedEnv.TRANSACTION_RPC_URL_BACKUP ?? null,
      }),
      signers: Object.freeze({
        mintSignerPrivateKey:
          parsedEnv.MINT_SIGNER_PRIVATE_KEY ?? (isLocalNetwork ? LOCAL_DEV_MINT_SIGNER_PRIVATE_KEY : ''),
        relayerSignerPrivateKey:
          parsedEnv.RELAYER_SIGNER_PRIVATE_KEY ??
          (isLocalNetwork ? LOCAL_DEV_RELAYER_SIGNER_PRIVATE_KEY : ''),
      }),
      rawTxEncryptionKey: Buffer.from(parsedEnv.RAW_TX_ENCRYPTION_KEY, 'base64'),
      pollIntervalMs: parsedEnv.SUBMISSION_POLL_INTERVAL_MS,
      rbfThresholdMs: parsedEnv.RBF_THRESHOLD_MS,
      rbfMaxAttempts: parsedEnv.RBF_MAX_ATTEMPTS,
      rbfFeeBumpPercent: parsedEnv.RBF_FEE_BUMP_PERCENT,
    }),
    confirmation: Object.freeze({
      blocksRequired: parsedEnv.CONFIRMATION_BLOCKS_REQUIRED,
      reconciliationPollIntervalMs: parsedEnv.RECONCILIATION_POLL_INTERVAL_MS,
      reconciliationBatchSize: parsedEnv.RECONCILIATION_BATCH_SIZE,
    }),
    mint: Object.freeze({
      metadataBaseUri: parsedEnv.MINT_METADATA_BASE_URI,
    }),
    ownerConsent: Object.freeze({
      deadlineSeconds: parsedEnv.OWNER_CONSENT_DEADLINE_SECONDS,
    }),
    notification: Object.freeze({
      callbackUrl: parsedEnv.NOTIFICATION_CALLBACK_URL,
      hmacOutbound: Object.freeze({
        keyId: parsedEnv.HMAC_OUTBOUND_KEY_ID,
        secret: Buffer.from(parsedEnv.HMAC_OUTBOUND_KEY_SECRET, 'base64url'),
      }),
      timeoutMs: parsedEnv.NOTIFICATION_TIMEOUT_MS,
      maxAutoRetries: parsedEnv.NOTIFICATION_MAX_AUTO_RETRIES,
      baseBackoffMs: parsedEnv.NOTIFICATION_BASE_BACKOFF_MS,
      maxBackoffMs: parsedEnv.NOTIFICATION_MAX_BACKOFF_MS,
      pollIntervalMs: parsedEnv.NOTIFICATION_POLL_INTERVAL_MS,
      batchSize: parsedEnv.NOTIFICATION_BATCH_SIZE,
    }),
  });
}
