import { z } from 'zod';

/** A base64url-encoded secret decoding to at least 32 raw bytes (HMAC 규칙: "최소 32바이트 무작위
 * secret"). Rejects anything shorter or non-base64url rather than silently using a weak key. */
const minLength32Base64UrlSecret = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64url').length >= 32;
      } catch {
        return false;
      }
    },
    { message: 'must be a base64url-encoded secret of at least 32 bytes' },
  );

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Selects which `<network>.json` deployment artifact to load (e.g. "hardhatMainnet", "amoy"). */
  CUBE_NFT_NETWORK: z.string().min(1, 'CUBE_NFT_NETWORK is required'),
  /** Overrides where deployment artifacts are read from. Defaults to the `@cube-nft/contracts`
   * package's `deployments/` directory; tests point this at fixtures instead. */
  CUBE_NFT_DEPLOYMENTS_DIR: z.string().min(1).optional(),

  /** `mysql://user:password@host:port/database` — the Blockchain Server's own MySQL, never the
   * Backend's (TASK-04 §9). */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(0),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** Backend -> Blockchain Server request authentication (TASK-06). Current key is required;
   * previous key is optional and only present during a 90-day rotation window, per the plan's HMAC
   * key rotation policy (both keys accepted while set). */
  HMAC_INBOUND_KEY_ID: z.string().min(1, 'HMAC_INBOUND_KEY_ID is required'),
  HMAC_INBOUND_KEY_SECRET: minLength32Base64UrlSecret,
  HMAC_INBOUND_PREVIOUS_KEY_ID: z.string().min(1).optional(),
  HMAC_INBOUND_PREVIOUS_KEY_SECRET: minLength32Base64UrlSecret.optional(),

  /** ARZONE approval JWT (HS256, <=30min, separate key from the HMAC keys above — TASK-06 §5). */
  APPROVAL_JWT_SECRET: minLength32Base64UrlSecret,
  APPROVAL_JWT_ISSUER: z.string().min(1, 'APPROVAL_JWT_ISSUER is required'),
  APPROVAL_JWT_AUDIENCE: z.string().min(1, 'APPROVAL_JWT_AUDIENCE is required'),

  /** TASK-05: which `CustodialWalletPort` implementation `WalletModule` binds. "fake" (default) is
   * the deterministic local adapter — always available, no external credentials. "web3auth" is the
   * real adapter; see `Web3AuthAdapter` for exactly what else that then requires. */
  CUSTODIAL_WALLET_PROVIDER: z.enum(['fake', 'web3auth']).default('fake'),
  WEB3AUTH_CLIENT_ID: z.string().min(1).optional(),
  WEB3AUTH_NETWORK: z.string().min(1).default('sapphire_devnet'),
  /** Chain the Web3Auth client is constructed against (its constructor requires at least one).
   * Defaults to Polygon Amoy's chainId. */
  WEB3AUTH_CHAIN_ID: z.coerce.number().int().positive().default(80002),
  WEB3AUTH_RPC_TARGET: z.string().min(1).optional(),
  /** The Custom Auth Connection id from the Web3Auth dashboard, configured to trust this
   * adapter's self-signed JWKS. Not required to construct the client — only to actually call
   * `connect()` — so it stays optional here; `Web3AuthAdapter` throws a clear, specific error if a
   * caller reaches it unset. */
  WEB3AUTH_AUTH_CONNECTION_ID: z.string().min(1).optional(),
  /** ES256 private key (PEM) this adapter self-signs "Custom JWT" idTokens with. `\n` written
   * literally in a .env file is normalized to real newlines. */
  WEB3AUTH_JWT_SIGNING_PRIVATE_KEY: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\\n/g, '\n'))
    .optional(),
  WEB3AUTH_JWT_SIGNING_KEY_ID: z.string().min(1).optional(),

  /** TASK-10: chain RPC endpoints for transaction submission (separate from Web3Auth's own RPC
   * target). Primary/backup failover, per NFR-012~014. Optional here — required only for non-local
   * networks, defaulted for `hardhatMainnet`/`hardhatOp` in `loadConfig` (see there for why). */
  TRANSACTION_RPC_URL_PRIMARY: z.string().min(1).optional(),
  TRANSACTION_RPC_URL_BACKUP: z.string().min(1).optional(),
  /** ARZONE-operated signer keys (not user custodial wallets): MINTER_ROLE and
   * AUTHORIZED_TRANSFER_ROLE on `CubeNFT`. Defaulted to Hardhat's well-known dev mnemonic accounts
   * #1/#2 on local networks only (matches `deploy.ts`'s local role fallback) — see `loadConfig`. */
  MINT_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key (0x-prefixed)')
    .optional(),
  RELAYER_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex private key (0x-prefixed)')
    .optional(),
  /** AES-256-GCM key (base64, 32 raw bytes) encrypting `TransactionAttempt.rawTransactionCiphertext`
   * at rest. Dev/test only — production uses KMS envelope encryption instead (TASK-10 §5), which is
   * out of scope for this deployment target. */
  RAW_TX_ENCRYPTION_KEY: z
    .string()
    .min(1, 'RAW_TX_ENCRYPTION_KEY is required')
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message: 'must be a base64-encoded 32-byte AES-256-GCM key',
    }),
  SUBMISSION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /** How long a BROADCAST attempt may sit unconfirmed before the pending monitor fee-bumps it. */
  RBF_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  RBF_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RBF_FEE_BUMP_PERCENT: z.coerce.number().int().positive().default(15),

  /** TASK-11: confirmation and reconciliation. */
  CONFIRMATION_BLOCKS_REQUIRED: z.coerce.number().int().positive().default(5),
  RECONCILIATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RECONCILIATION_BATCH_SIZE: z.coerce.number().int().positive().default(20),

  /** TASK-08/09: how long an `OwnerConsent` signature stays valid after the worker signs it. Kept
   * short — this is minted fresh right before each submission attempt, not handed out in advance. */
  OWNER_CONSENT_DEADLINE_SECONDS: z.coerce.number().int().positive().default(600),

  /** TASK-12: outbound completion webhook to Backend. A separate HMAC key pair from
   * HMAC_INBOUND_* — "방향별 HMAC key" — since this direction is us authenticating *to* Backend,
   * not Backend authenticating to us. */
  NOTIFICATION_CALLBACK_URL: z.string().min(1),
  HMAC_OUTBOUND_KEY_ID: z.string().min(1),
  HMAC_OUTBOUND_KEY_SECRET: minLength32Base64UrlSecret,
  NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  NOTIFICATION_MAX_AUTO_RETRIES: z.coerce.number().int().positive().default(6),
  NOTIFICATION_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(2000),
  NOTIFICATION_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(300000),
  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  NOTIFICATION_BATCH_SIZE: z.coerce.number().int().positive().default(20),

  /** TASK-13: "fake" (default) is a deterministic, content-addressed local stand-in — always
   * available, no external credentials, real enough to test the whole pipeline (dependency
   * tracking, READY gating, tokenURI) against. "real" binds the actual Pinata/NFT.Storage
   * adapters; see PinataPinningAdapter/NftStoragePreservationAdapter for exactly what that then
   * requires. */
  METADATA_PROVIDER: z.enum(['fake', 'real']).default('fake'),
  PINATA_JWT: z.string().min(1).optional(),
  NFT_STORAGE_TOKEN: z.string().min(1).optional(),
  METADATA_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  /** TASK-14: structured logging level. */
  LOG_LEVEL: z.enum(['debug', 'log', 'warn', 'error']).default('log'),
  /** How long an Operation may sit SUBMITTED/PENDING/UNKNOWN before reconciliation records a
   * LONG_PENDING failure for it (once per still-unresolved occurrence, not every poll tick). */
  LONG_PENDING_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  /** A key pair distinct from HMAC_INBOUND_* — TASK-14 §5: "조회 API는 HMAC 운영 key scope를 분리" —
   * so the audit/failure operator query endpoints can never be reached with the same key Backend
   * uses to create Operations. Same rotation shape as HMAC_INBOUND_*. */
  HMAC_OPERATOR_KEY_ID: z.string().min(1, 'HMAC_OPERATOR_KEY_ID is required'),
  HMAC_OPERATOR_KEY_SECRET: minLength32Base64UrlSecret,
  HMAC_OPERATOR_PREVIOUS_KEY_ID: z.string().min(1).optional(),
  HMAC_OPERATOR_PREVIOUS_KEY_SECRET: minLength32Base64UrlSecret.optional(),
});

/** Local-only Hardhat networks whose signer/RPC config may fall back to well-known dev defaults —
 * mirrors `contracts/cube-nft/scripts/deploy.ts`'s `LOCAL_NETWORK_NAMES`. */
export const LOCAL_NETWORK_NAMES = new Set(['hardhatMainnet', 'hardhatOp']);

export const envSchema = baseEnvSchema
  .refine(
    (env) => LOCAL_NETWORK_NAMES.has(env.CUBE_NFT_NETWORK) || Boolean(env.TRANSACTION_RPC_URL_PRIMARY),
    {
      message: 'TRANSACTION_RPC_URL_PRIMARY is required for non-local networks',
      path: ['TRANSACTION_RPC_URL_PRIMARY'],
    },
  )
  .refine((env) => LOCAL_NETWORK_NAMES.has(env.CUBE_NFT_NETWORK) || Boolean(env.MINT_SIGNER_PRIVATE_KEY), {
    message: 'MINT_SIGNER_PRIVATE_KEY is required for non-local networks',
    path: ['MINT_SIGNER_PRIVATE_KEY'],
  })
  .refine((env) => LOCAL_NETWORK_NAMES.has(env.CUBE_NFT_NETWORK) || Boolean(env.RELAYER_SIGNER_PRIVATE_KEY), {
    message: 'RELAYER_SIGNER_PRIVATE_KEY is required for non-local networks',
    path: ['RELAYER_SIGNER_PRIVATE_KEY'],
  })
  .refine(
    (env) => Boolean(env.HMAC_INBOUND_PREVIOUS_KEY_ID) === Boolean(env.HMAC_INBOUND_PREVIOUS_KEY_SECRET),
    {
      message:
        'HMAC_INBOUND_PREVIOUS_KEY_ID and HMAC_INBOUND_PREVIOUS_KEY_SECRET must be set together (a rotation key ' +
        'needs both an id and a secret) or not at all',
      path: ['HMAC_INBOUND_PREVIOUS_KEY_SECRET'],
    },
  )
  .refine((env) => env.CUSTODIAL_WALLET_PROVIDER !== 'web3auth' || Boolean(env.WEB3AUTH_CLIENT_ID), {
    message: 'WEB3AUTH_CLIENT_ID is required when CUSTODIAL_WALLET_PROVIDER=web3auth',
    path: ['WEB3AUTH_CLIENT_ID'],
  })
  .refine((env) => env.CUSTODIAL_WALLET_PROVIDER !== 'web3auth' || Boolean(env.WEB3AUTH_RPC_TARGET), {
    message: 'WEB3AUTH_RPC_TARGET is required when CUSTODIAL_WALLET_PROVIDER=web3auth',
    path: ['WEB3AUTH_RPC_TARGET'],
  })
  .refine((env) => env.METADATA_PROVIDER !== 'real' || Boolean(env.PINATA_JWT), {
    message: 'PINATA_JWT is required when METADATA_PROVIDER=real',
    path: ['PINATA_JWT'],
  })
  .refine((env) => env.METADATA_PROVIDER !== 'real' || Boolean(env.NFT_STORAGE_TOKEN), {
    message: 'NFT_STORAGE_TOKEN is required when METADATA_PROVIDER=real',
    path: ['NFT_STORAGE_TOKEN'],
  })
  .refine(
    (env) => Boolean(env.HMAC_OPERATOR_PREVIOUS_KEY_ID) === Boolean(env.HMAC_OPERATOR_PREVIOUS_KEY_SECRET),
    {
      message:
        'HMAC_OPERATOR_PREVIOUS_KEY_ID and HMAC_OPERATOR_PREVIOUS_KEY_SECRET must be set together (a rotation ' +
        'key needs both an id and a secret) or not at all',
      path: ['HMAC_OPERATOR_PREVIOUS_KEY_SECRET'],
    },
  );

export type Env = z.infer<typeof envSchema>;
