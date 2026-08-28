/**
 * `npm run auth:headers -- --method POST --path /internal/v1/wallets --body '{"userId":"u1"}' [--scope inbound|operator]
 *    [--jwt '{"purpose":"MINT",...}'] [--jwt-exp-seconds 1800] [--out /tmp/arzone.headers]`
 *
 * 검증 계획서 §4 required tool: writes a curl `-H @file` header file for one request — the same
 * canonical HMAC construction `HmacGuard` verifies (imported, not re-implemented) plus, when `--jwt`
 * is given, an ARZONE approval JWT (`Authorization: Bearer …`).
 *
 * Secrets come from the repository-root `.env` (or the environment) and are **never printed**; only
 * the resulting headers are. Each invocation produces a fresh nonce/timestamp, so a header file is
 * valid for exactly one request (HMAC nonces are single-use).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import jwt from 'jsonwebtoken';

import { buildCanonicalString, computeHmacSignatureHex } from '../src/shared/auth/hmac/canonical-request';

const REPO_ROOT_ENV_FILE = path.join(__dirname, '..', '..', '.env');
if (existsSync(REPO_ROOT_ENV_FILE)) {
  loadDotenv({ path: REPO_ROOT_ENV_FILE });
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in the environment / .env`);
    process.exit(2);
  }
  return value;
}

function main(): void {
  const method = (arg('method') ?? 'GET').toUpperCase();
  const rawPath = arg('path');
  if (!rawPath) {
    console.error('Usage: npm run auth:headers -- --method <M> --path </internal/v1/...> [--body <json>] [--scope inbound|operator] [--jwt <claims json>] [--out <file>]');
    process.exit(2);
  }
  const body = arg('body') ?? '';
  const scope = arg('scope') ?? 'inbound';
  const outFile = arg('out');

  const url = new URL(rawPath, 'http://localhost');
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const keyId = scope === 'operator' ? requireEnv('HMAC_OPERATOR_KEY_ID') : requireEnv('HMAC_INBOUND_KEY_ID');
  const secret = Buffer.from(
    scope === 'operator' ? requireEnv('HMAC_OPERATOR_KEY_SECRET') : requireEnv('HMAC_INBOUND_KEY_SECRET'),
    'base64url',
  );

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = buildCanonicalString({
    method,
    path: url.pathname,
    query,
    timestamp,
    nonce,
    rawBody: Buffer.from(body, 'utf8'),
  });
  const signature = computeHmacSignatureHex(secret, canonical);

  const lines = [
    `X-ARZONE-Key-Id: ${keyId}`,
    `X-ARZONE-Timestamp: ${timestamp}`,
    `X-ARZONE-Nonce: ${nonce}`,
    `X-ARZONE-Signature: ${signature}`,
  ];

  const jwtClaims = arg('jwt');
  if (jwtClaims) {
    const claims = JSON.parse(jwtClaims) as Record<string, unknown>;
    if (!claims.jti) {
      claims.jti = randomUUID();
    }
    const token = jwt.sign(claims, Buffer.from(requireEnv('APPROVAL_JWT_SECRET'), 'base64url'), {
      algorithm: 'HS256',
      issuer: requireEnv('APPROVAL_JWT_ISSUER'),
      audience: requireEnv('APPROVAL_JWT_AUDIENCE'),
      expiresIn: Number(arg('jwt-exp-seconds') ?? '1800'),
    });
    lines.push(`Authorization: Bearer ${token}`);
  }

  const output = `${lines.join('\n')}\n`;
  if (outFile) {
    writeFileSync(outFile, output, { mode: 0o600 });
    console.error(`wrote ${lines.length} header(s) to ${outFile}`);
  } else {
    process.stdout.write(output);
  }
}

main();
