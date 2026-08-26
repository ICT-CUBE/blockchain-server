import { envSchema, type Env } from './env.schema';
import { loadCubeNftContract, type LoadedContract } from './contract-deployment.loader';

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMin: number;
  readonly poolMax: number;
}

export interface AppConfig {
  readonly nodeEnv: Env['NODE_ENV'];
  readonly port: number;
  readonly network: string;
  readonly cubeNft: LoadedContract;
  readonly database: DatabaseConfig;
}

/** Validates `env` against `envSchema` and loads the matching CubeNFT deployment artifact. Throws
 * on any missing/invalid value so callers get fail-fast startup rather than a partially-configured
 * app. Never logs or returns `database.url` verbatim — it may embed a password. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);
  const cubeNft = loadCubeNftContract(parsedEnv.CUBE_NFT_NETWORK, parsedEnv.CUBE_NFT_DEPLOYMENTS_DIR);

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
  });
}
