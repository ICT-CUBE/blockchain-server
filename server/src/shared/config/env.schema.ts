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
});

export const envSchema = baseEnvSchema.refine(
  (env) => Boolean(env.HMAC_INBOUND_PREVIOUS_KEY_ID) === Boolean(env.HMAC_INBOUND_PREVIOUS_KEY_SECRET),
  {
    message:
      'HMAC_INBOUND_PREVIOUS_KEY_ID and HMAC_INBOUND_PREVIOUS_KEY_SECRET must be set together (a rotation key ' +
      'needs both an id and a secret) or not at all',
    path: ['HMAC_INBOUND_PREVIOUS_KEY_SECRET'],
  },
);

export type Env = z.infer<typeof envSchema>;
