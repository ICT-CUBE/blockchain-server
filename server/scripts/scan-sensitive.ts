/**
 * `npm run scan:sensitive -- <file-or-dir>... [--secret-env NAME,NAME] [--strict] [--json]`
 *
 * 검증 개선안 §13 scanner: checks logs / DB dumps / evidence files for material that must never
 * appear there (명세 §15, T14 §9). Multiple rules, not one prefix:
 *
 * - signed raw transactions: EIP-2718 typed (`0x01`, `0x02`, `0x03`, `0x04` + RLP list `0xc0-0xff`/
 *   `0xf8-0xff`) and legacy (`0xf8`/`0xf9` + …) hex runs of ≥ 200 chars — **gating**;
 * - 65-byte ECDSA signatures (`0x` + 130 hex) — owner/consent signatures — **gating**;
 * - JSON-RPC payload echoes (`"params":[`, `request={`, `payload={`) — **gating**;
 * - JWTs (`eyJ…` two-segment) — **gating**;
 * - literal secrets passed via `--secret-env` (read from the environment / .env, never printed) —
 *   **gating**, and the reliable way to catch a leaked private key / HMAC / JWT secret;
 * - 32-byte hex (`0x` + 64) that is not in an obvious hash context — **advisory only**: a keccak256
 *   tx/block hash and a raw private key are byte-for-byte identical, and a `mysqldump` row loses the
 *   column name that would disambiguate them (검증 피드백 2026-08-28), so this rule reported every
 *   `transaction_attempts.tx_hash` as `POSSIBLE_KEY_32B` and made the tool unusable as a DB-dump gate.
 *   It is still printed and included in the JSON manifest; pass `--strict` to make it (and any other
 *   advisory rule) gate too — appropriate for scanning *logs*, which should never contain either.
 *
 * Prints a manifest (inputs, rules, counts) and exits 1 when any **gating** finding is present
 * (or any finding at all under `--strict`) so it can gate CI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

const REPO_ROOT_ENV_FILE = path.join(__dirname, '..', '..', '.env');
if (existsSync(REPO_ROOT_ENV_FILE)) {
  loadDotenv({ path: REPO_ROOT_ENV_FILE });
}

interface Rule {
  id: string;
  pattern: RegExp;
  /** Optional context filter: a match is dropped when the 40 chars before it match this. */
  ignoreIfPrecededBy?: RegExp;
  /** `false` = reported but does not drive the exit code unless `--strict` is passed. Default true. */
  gating?: boolean;
}

export const RULES: Rule[] = [
  { id: 'RAW_TX_TYPED', pattern: /0x0[1-4](?:f[89a-f]|c[0-9a-f]|d[0-9a-f]|e[0-9a-f])[0-9a-fA-F]{196,}/gu },
  { id: 'RAW_TX_LEGACY', pattern: /0xf[89][0-9a-fA-F]{198,}/gu },
  { id: 'SIGNATURE_65B', pattern: /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/gu },
  {
    id: 'POSSIBLE_KEY_32B',
    pattern: /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gu,
    ignoreIfPrecededBy: /(tx[_ ]?hash|block[_ ]?hash|hash|keccak|txhash|blockhash|"tx"|digest|topic|0x[0-9a-fA-F]{2,})[^0-9a-fA-F]{0,12}$/iu,
    // Advisory: indistinguishable from a keccak256 hash by shape alone. `SECRET_LITERAL`
    // (--secret-env) is the reliable gate for the actual configured private keys.
    gating: false,
  },
  { id: 'RPC_PAYLOAD_ECHO', pattern: /"params"\s*:\s*\[|request=\{|payload=\{/gu },
  { id: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
];

/** Whether a finding's rule drives the exit code. `SECRET_LITERAL` (not in `RULES`) always gates. */
export function isGating(ruleId: string): boolean {
  if (ruleId === 'SECRET_LITERAL') {
    return true;
  }
  return RULES.find((r) => r.id === ruleId)?.gating !== false;
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  sample: string;
}

export function scanText(file: string, text: string, secrets: string[]): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        const before = line.slice(Math.max(0, match.index - 40), match.index);
        if (rule.ignoreIfPrecededBy && rule.ignoreIfPrecededBy.test(before)) {
          continue;
        }
        findings.push({ file, line: index + 1, rule: rule.id, sample: `${match[0].slice(0, 18)}…(${match[0].length} chars)` });
      }
    }
    for (const secret of secrets) {
      if (secret.length >= 16 && line.includes(secret)) {
        findings.push({ file, line: index + 1, rule: 'SECRET_LITERAL', sample: '[literal secret value present]' });
      }
    }
  });
  return findings;
}

function collectFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      console.error(`skip (not found): ${input}`);
      continue;
    }
    const stat = statSync(input);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(input)) {
        files.push(...collectFiles([path.join(input, entry)]));
      }
    } else if (stat.size < 200 * 1024 * 1024) {
      files.push(input);
    }
  }
  return files;
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const secretEnvIndex = argv.indexOf('--secret-env');
  const secretEnvNames = secretEnvIndex >= 0 ? (argv[secretEnvIndex + 1] ?? '').split(',').filter(Boolean) : [];
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !(secretEnvIndex >= 0 && i === secretEnvIndex + 1));
  if (inputs.length === 0) {
    console.error(
      'Usage: npm run scan:sensitive -- <file-or-dir>... [--secret-env NAME,NAME] [--strict] [--json]',
    );
    process.exit(2);
  }
  const secrets = secretEnvNames.map((name) => process.env[name] ?? '').filter((v) => v.length > 0);
  const files = collectFiles(inputs);
  const started = new Date().toISOString();
  const findings = files.flatMap((file) => scanText(file, readFileSync(file, 'utf8'), secrets));
  const gatingFindings = findings.filter((f) => strict || isGating(f.rule));
  const advisoryFindings = findings.filter((f) => !strict && !isGating(f.rule));

  const manifest = {
    scanner: 'scan-sensitive.ts',
    rules: RULES.map((r) => r.id).concat(secrets.length > 0 ? ['SECRET_LITERAL'] : []),
    strict,
    secretEnvNames,
    inputs: files,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    findingCount: findings.length,
    gatingFindingCount: gatingFindings.length,
    advisoryFindingCount: advisoryFindings.length,
    findings: findings.map((f) => ({ ...f, gating: strict || isGating(f.rule) })),
  };
  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(
      `scanned ${files.length} file(s) with rules [${manifest.rules.join(', ')}]${strict ? ' (strict)' : ''}`,
    );
    for (const f of findings) {
      const tag = strict || isGating(f.rule) ? '' : '\t(advisory)';
      console.log(`${f.rule}\t${f.file}:${f.line}\t${f.sample}${tag}`);
    }
    console.log(
      `findings: ${findings.length} (gating: ${gatingFindings.length}, advisory: ${advisoryFindings.length})`,
    );
  }
  process.exit(gatingFindings.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}
