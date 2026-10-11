import { readdir, mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function packageWindowsRelease({
  bundle,
  destination,
  version,
  sourceCommit,
  channel,
  notesAr,
}) {
  if (
    !['test', 'production'].includes(channel) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
    version.length > 64 ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    typeof notesAr !== 'string' ||
    !notesAr.trim() ||
    notesAr.length > 4000
  )
    throw new Error('RELEASE_METADATA_INVALID');
  const installers = (await readdir(bundle, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.exe'),
  );
  if (installers.length !== 1) throw new Error('RELEASE_BUNDLE_AMBIGUOUS');
  const source = join(bundle, installers[0].name),
    signature = source + '.sig';
  const bytes = (await stat(source)).size;
  if (
    !bytes ||
    bytes > 512 * 1_048_576 ||
    (await stat(signature)).size > 4096 ||
    !(await readFile(signature, 'utf8')).trim()
  )
    throw new Error('RELEASE_SIZE_INVALID');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const name =
    channel === 'test'
      ? `Mawjivo-Acceptance_${version}_${sourceCommit.slice(0, 8)}_x64-setup.exe`
      : `Mawjivo_${version}_x64-setup.exe`;
  const metadata = { name, version, sourceCommit, notesAr, bytes, sha256: hash.digest('hex') };
  await mkdir(destination, { recursive: true });
  await copyFile(source, join(destination, name), constants.COPYFILE_EXCL);
  await copyFile(signature, join(destination, name + '.sig'), constants.COPYFILE_EXCL);
  await writeFile(
    join(destination, 'package-info.json'),
    JSON.stringify(metadata, null, 2) + '\n',
    { flag: 'wx' },
  );
  return metadata;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [bundle, destination, version, sourceCommit, channel, notesPath] = process.argv.slice(2);
    const metadata = await packageWindowsRelease({
      bundle,
      destination,
      version,
      sourceCommit,
      channel,
      notesAr: await readFile(notesPath, 'utf8'),
    });
    console.log(JSON.stringify(metadata));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
