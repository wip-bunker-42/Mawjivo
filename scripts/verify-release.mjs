import { readFile, realpath, stat, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function verifySigned(input) {
  const temporary = await mkdtemp(join(tmpdir(), 'mawjivo-verify-'));
  const publicPath = join(temporary, 'public.key');
  try {
    await writeFile(publicPath, input.publicKey + '\n');
    const executable =
      process.env.MAWJIVO_RELEASE_VERIFIER ??
      join(
        root,
        'apps/desktop/src-tauri/target/release/verify_update' +
          (process.platform === 'win32' ? '.exe' : ''),
      );
    const result = spawnSync(
      executable,
      [input.installerPath, input.signaturePath, publicPath, input.version],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 },
    );
    if (result.error) throw new Error('RELEASE_VERIFIER_UNAVAILABLE');
    if (result.status !== 0) throw new Error('RELEASE_SIGNATURE_INVALID');
    const proof = JSON.parse(result.stdout);
    if (proof.valid !== true || proof.version !== input.version)
      throw new Error('RELEASE_SIGNATURE_INVALID');
  } finally {
    await unlink(publicPath).catch(() => {});
    await rmdir(temporary).catch(() => {});
  }
}
export async function verifyReleasePackage(directory, options = {}) {
  const channel = options.channel;
  if (channel !== 'test' && channel !== 'production') throw new Error('RELEASE_CHANNEL');
  const packageDirectory = await realpath(resolve(directory));
  const metadata = JSON.parse(await readFile(join(packageDirectory, 'package-info.json'), 'utf8'));
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(metadata.version) ||
    metadata.version.length > 64 ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceCommit) ||
    typeof metadata.notesAr !== 'string' ||
    !metadata.notesAr.trim() ||
    metadata.notesAr.length > 4000 ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes <= 0 ||
    metadata.bytes > 512 * 1_048_576 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error('RELEASE_METADATA');
  if (!/^Mawjivo[A-Za-z0-9_.-]{1,160}\.exe$/.test(metadata.name))
    throw new Error('RELEASE_FILENAME');
  const installerPath = join(packageDirectory, metadata.name),
    signaturePath = installerPath + '.sig';
  for (const path of [installerPath, signaturePath]) {
    if (dirname(await realpath(path)) !== packageDirectory || !(await stat(path)).isFile())
      throw new Error('RELEASE_FILENAME');
  }
  if (
    (await stat(installerPath)).size !== metadata.bytes ||
    (await hashFile(installerPath)) !== metadata.sha256
  )
    throw new Error('RELEASE_DIGEST_MISMATCH');
  if ((await stat(signaturePath)).size > 4096) throw new Error('RELEASE_SIGNATURE_INVALID');
  const signature = (await readFile(signaturePath, 'utf8')).trim();
  const config = JSON.parse(
    await readFile(
      join(
        root,
        channel === 'test'
          ? 'tools/acceptance-tauri.json'
          : 'apps/desktop/src-tauri/tauri.conf.json',
      ),
      'utf8',
    ),
  );
  const publicKey = config.plugins.updater.pubkey;
  await (options.verifySigned ?? verifySigned)({
    installerPath,
    signaturePath,
    publicKey,
    version: metadata.version,
  });
  const prefix = 'releases/' + metadata.version + '/';
  const origin = 'https://downloads.aimansour.com/';
  const objects = [
    {
      name: metadata.name,
      path: installerPath,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      contentType: 'application/vnd.microsoft.portable-executable',
    },
    {
      name: metadata.name + '.sig',
      path: signaturePath,
      bytes: (await stat(signaturePath)).size,
      sha256: await hashFile(signaturePath),
      contentType: 'text/plain; charset=utf-8',
    },
  ].map((object) => ({ ...object, key: prefix + object.name, url: origin + prefix + object.name }));
  return {
    ...metadata,
    channel,
    objects,
    manifest: {
      version: metadata.version,
      notes: metadata.notesAr,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      sourceCommit: metadata.sourceCommit,
      platforms: { 'windows-x86_64': { url: objects[0].url, signature } },
    },
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyReleasePackage(process.argv[2], { channel: process.argv[3] });
    console.log(
      JSON.stringify({
        verified: true,
        version: result.version,
        bytes: result.bytes,
        sourceCommit: result.sourceCommit,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
