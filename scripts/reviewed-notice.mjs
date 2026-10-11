import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function reviewedNotice(crate, manifest, override, reader = readFile) {
  const declared = /(?:^|\n)license = "([^"]+)"/.exec(manifest)?.[1];
  const text = (await reader(override.licenseFile, 'utf8')).replaceAll('\r\n', '\n');
  if (
    declared !== override.license ||
    createHash('sha256').update(text).digest('hex') !== override.licenseSha256
  )
    throw new Error('REVIEWED_LICENSE_MISMATCH');
  return {
    section:
      crate +
      '\nAuthors: ' +
      override.authors +
      '\nUnmodified source: ' +
      override.sourceUrl +
      '\nSource SHA-256: ' +
      override.sourceSha256 +
      '\nLicense: ' +
      override.licenseUrl +
      '\n' +
      text,
    provenance: { crate, ...override },
  };
}
