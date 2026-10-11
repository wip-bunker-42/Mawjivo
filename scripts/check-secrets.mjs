import { readFile, lstat, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Exact, conspicuously synthetic tokens used by the existing provider tests.
// Do not exempt test directories or whole credential families.
const examples = new Set([
  '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'synthetic-cf-token-not-real',
]);
const rules = [
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['telegram', /\b\d{6,20}:[A-Za-z0-9_-]{30,100}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    'credential-assignment',
    /\b[A-Z_]*(?:API[_-]?TOKEN|API[_-]?KEY|BOT[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET[_-]?ACCESS[_-]?KEY|ENCRYPTION[_-]?KEY|SIGNING[_-]?KEY|DEVICE[_-]?TOKEN)["']?\s*[:=]\s*["']?([A-Za-z0-9_+\/=:-]{24,})/gi,
  ],
];
export function findSecrets(source) {
  const findings = [];
  for (const [kind, pattern] of rules) {
    for (const match of source.matchAll(pattern)) {
      const candidate = match[1] ?? match[0];
      if (
        examples.has(candidate) ||
        /^(?:YOUR_|EXAMPLE_|REPLACE_|TEST_|PLACEHOLDER)/i.test(candidate)
      )
        continue;
      findings.push({ kind, line: source.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}
async function filesAt(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const files = [];
  for (const entry of await readdir(path)) files.push(...(await filesAt(join(path, entry))));
  return files;
}
async function main() {
  let paths = process.argv.slice(2).filter((p) => p !== '--');
  if (!paths.length) {
    const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Tracked file inventory failed');
    paths = result.stdout.split('\0').filter(Boolean);
  }
  const files = new Set();
  for (const path of paths) for (const file of await filesAt(resolve(path))) files.add(file);
  let count = 0;
  for (const file of files) {
    const body = await readFile(file);
    if (body.includes(0)) continue;
    for (const finding of findSecrets(body.toString('utf8'))) {
      console.error(
        `SECRET_DETECTED ${relative(process.cwd(), file)}:${finding.line} (${finding.kind})`,
      );
      count++;
    }
  }
  if (count) process.exitCode = 1;
  else console.log(`Secret check passed (${files.size} files).`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('SECRET_CHECK_FAILED: unable to inspect all requested files.');
    process.exitCode = 1;
  });
