import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { reviewedNotice } from '../reviewed-notice.mjs';
const text = 'The full reviewed license.\nCopyright the fixture authors.\n';
const override = {
  license: 'MPL-2.0',
  licenseFile: 'fixture-license.txt',
  licenseSha256: createHash('sha256').update(text).digest('hex'),
  authors: 'Fixture authors',
  sourceUrl: 'https://example.test/source-0.1.crate',
  sourceSha256: 'a'.repeat(64),
  licenseUrl: 'https://example.test/license',
};
test('a Windows checkout retains the complete reviewed license and exact source provenance', async () => {
  const notice = await reviewedNotice(
    'fixture-0.1',
    'license = "MPL-2.0"\r\n',
    override,
    async () => text.replaceAll('\n', '\r\n'),
  );
  assert.ok(notice.section.endsWith(text));
  assert.ok(notice.section.includes(override.sourceUrl));
  assert.ok(notice.section.includes(override.sourceSha256));
});
test('a changed license or declaration fails instead of substituting reviewed text', async () => {
  await assert.rejects(
    reviewedNotice('fixture-0.1', 'license = "MIT"\n', override, async () => text),
  );
  await assert.rejects(
    reviewedNotice('fixture-0.1', 'license = "MPL-2.0"\n', override, async () => text + 'changed'),
  );
});
