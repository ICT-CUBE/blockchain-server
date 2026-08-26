import { z } from 'zod';

export const envSchema = z.object({
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
});

export type Env = z.infer<typeof envSchema>;
