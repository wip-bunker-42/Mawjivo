import { open } from 'node:fs/promises';
const required = [
  'MAWJIVO_SIGNING_PRIVATE_KEY',
  'MAWJIVO_TEST_SIGNING_PRIVATE_KEY',
  'MAWJIVO_RELEASE_ACCOUNT_ID',
  'MAWJIVO_RELEASE_ACCESS_KEY_ID',
  'MAWJIVO_RELEASE_SECRET_KEY',
];
export async function loadReleaseEnv(path) {
  const handle = await open(path, 'r').catch(() => {
    throw new Error('RELEASE_ENV_UNAVAILABLE');
  });
  let text;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('RELEASE_ENV_INVALID');
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset === bytes.length) throw new Error('RELEASE_ENV_LIMIT');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new Error('RELEASE_ENV_INVALID');
    }
  } finally {
    await handle.close();
  }
  const fields = {};
  for (const source of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('RELEASE_ENV_INVALID');
    const [, name, raw] = match;
    if (Object.hasOwn(fields, name)) throw new Error('RELEASE_ENV_DUPLICATE: ' + name);
    let value = raw.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.at(-1) !== value[0] || value.length < 2) throw new Error('RELEASE_ENV_INVALID');
      value = value.slice(1, -1);
    }
    fields[name] = value;
  }
  const key = fields.MAWJIVO_SIGNING_PRIVATE_KEY || fields.TAURI_SIGNING_PRIVATE_KEY;
  if (
    fields.MAWJIVO_SIGNING_PRIVATE_KEY &&
    fields.TAURI_SIGNING_PRIVATE_KEY &&
    fields.MAWJIVO_SIGNING_PRIVATE_KEY !== fields.TAURI_SIGNING_PRIVATE_KEY
  )
    throw new Error('RELEASE_SIGNING_KEY_CONFLICT');
  fields.MAWJIVO_SIGNING_PRIVATE_KEY = key;
  for (const name of required)
    if (typeof fields[name] !== 'string' || !fields[name])
      throw new Error('RELEASE_ENV_MISSING: ' + name);
  if (!/^[a-f0-9]{32}$/.test(fields.MAWJIVO_RELEASE_ACCOUNT_ID))
    throw new Error('RELEASE_ACCOUNT_INVALID');
  return Object.fromEntries([
    ...required.map((name) => [name, fields[name]]),
    ['TAURI_SIGNING_PRIVATE_KEY_PASSWORD', fields.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? ''],
  ]);
}
