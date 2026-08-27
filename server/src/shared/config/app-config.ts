import { envSchema, type Env } from './env.schema';
import { loadCubeNftContract, type LoadedContract } from './contract-deployment.loader';

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

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly network: string;
  readonly cubeNft: LoadedContract;
  readonly database: DatabaseConfig;
  readonly hmacInbound: HmacInboundConfig;
  readonly approvalJwt: ApprovalJwtConfig;
  readonly web3Auth: Web3AuthConfig;
}

/** Validates `env` against `envSchema` and loads the matching CubeNFT deployment artifact. Throws
 * on any missing/invalid value so callers get fail-fast startup rather than a partially-configured
 * app. Never logs or returns `database.url`, HMAC secrets, or the JWT secret verbatim. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);
  const cubeNft = loadCubeNftContract(parsedEnv.CUBE_NFT_NETWORK, parsedEnv.CUBE_NFT_DEPLOYMENTS_DIR);

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
  });
}
