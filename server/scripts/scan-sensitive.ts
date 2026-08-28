/**
 * `npm run scan:sensitive -- <file-or-dir>... [--secret-env NAME,NAME] [--json]`
 *
 * 검증 개선안 §13 scanner: checks logs / DB dumps / evidence files for material that must never
 * appear there (명세 §15, T14 §9). Multiple rules, not one prefix:
 *
 * - signed raw transactions: EIP-2718 typed (`0x01`, `0x02`, `0x03`, `0x04` + RLP list `0xc0-0xff`/
 *   `0xf8-0xff`) and legacy (`0xf8`/`0xf9` + …) hex runs of ≥ 200 chars;
 * - 65-byte ECDSA signatures (`0x` + 130 hex) — owner/consent signatures;
 * - 32-byte private-key-shaped hex that is *not* preceded by a hash context (`txHash`, `blockHash`,
 *   `tx_hash`, `block_hash`, `keccak`, `hash`) — heuristic, reported as `POSSIBLE_KEY`;
 * - JSON-RPC payload echoes (`"params":[`, `request={`, `payload={`);
 * - JWTs (`eyJ…` two-segment);
 * - literal secrets passed via `--secret-env` (read from the environment / .env, never printed).
 *
 * Prints a manifest (inputs, rules, counts) and exits 1 on any finding so it can gate CI.
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
}

export const RULES: Rule[] = [
  { id: 'RAW_TX_TYPED', pattern: /0x0[1-4](?:f[89a-f]|c[0-9a-f]|d[0-9a-f]|e[0-9a-f])[0-9a-fA-F]{196,}/gu },
  { id: 'RAW_TX_LEGACY', pattern: /0xf[89][0-9a-fA-F]{198,}/gu },
  { id: 'SIGNATURE_65B', pattern: /0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/gu },
  {
    id: 'POSSIBLE_KEY_32B',
    pattern: /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gu,
    ignoreIfPrecededBy: /(tx[_ ]?hash|block[_ ]?hash|hash|keccak|txhash|blockhash|"tx"|digest|topic|0x[0-9a-fA-F]{2,})[^0-9a-fA-F]{0,12}$/iu,
  },
  { id: 'RPC_PAYLOAD_ECHO', pattern: /"params"\s*:\s*\[|request=\{|payload=\{/gu },
  { id: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
];

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
  const secretEnvIndex = argv.indexOf('--secret-env');
  const secretEnvNames = secretEnvIndex >= 0 ? (argv[secretEnvIndex + 1] ?? '').split(',').filter(Boolean) : [];
  const inputs = argv.filter((a, i) => !a.startsWith('--') && !(secretEnvIndex >= 0 && i === secretEnvIndex + 1));
  if (inputs.length === 0) {
    console.error('Usage: npm run scan:sensitive -- <file-or-dir>... [--secret-env NAME,NAME] [--json]');
    process.exit(2);
  }
  const secrets = secretEnvNames.map((name) => process.env[name] ?? '').filter((v) => v.length > 0);
  const files = collectFiles(inputs);
  const started = new Date().toISOString();
  const findings = files.flatMap((file) => scanText(file, readFileSync(file, 'utf8'), secrets));

  const manifest = {
    scanner: 'scan-sensitive.ts',
    rules: RULES.map((r) => r.id).concat(secrets.length > 0 ? ['SECRET_LITERAL'] : []),
    secretEnvNames,
    inputs: files,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    findingCount: findings.length,
    findings,
  };
  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`scanned ${files.length} file(s) with rules [${manifest.rules.join(', ')}]`);
    for (const f of findings) {
      console.log(`${f.rule}\t${f.file}:${f.line}\t${f.sample}`);
    }
    console.log(`findings: ${findings.length}`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}
