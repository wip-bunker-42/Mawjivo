import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceDistribution } from '../accept-installed-update.mjs';

test('legacy replay locates its original distribution when the old artifact has no GitHub descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-legacy-distribution-'));
  try {
    assert.deepEqual(
      await acceptanceDistribution(directory, {
        version: '0.1.1',
        sourceCommit: 'a'.repeat(40),
        name: 'Mawjivo_0.1.1_x64-setup.exe',
      }),
      {
        manifestUrl: 'https://downloads.aimansour.com/updates/windows-x86_64-test.json',
        origin: 'https://downloads.aimansour.com',
        pathname: '/releases/0.1.1/Mawjivo_0.1.1_x64-setup.exe',
        redirect: 'error',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new artifacts use their source-bound GitHub tag and never fall back to the old host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-github-distribution-'));
  const next = {
    version: '0.1.2',
    sourceCommit: 'a'.repeat(40),
    name: 'Mawjivo_0.1.2_x64-setup.exe',
  };
  try {
    await assert.rejects(acceptanceDistribution(directory, next));
    await writeFile(
      join(directory, 'github-distribution.json'),
      JSON.stringify({ tag: 'acceptance-v0.1.2-aaaaaaaa' }),
    );
    assert.deepEqual(await acceptanceDistribution(directory, next), {
      manifestUrl:
        'https://github.com/wip-bunker-42/Mawjivo/releases/download/acceptance-v0.1.2-aaaaaaaa/update-test.json',
      origin: 'https://github.com',
      pathname:
        '/wip-bunker-42/Mawjivo/releases/download/acceptance-v0.1.2-aaaaaaaa/Mawjivo_0.1.2_x64-setup.exe',
      redirect: 'follow',
    });
    await writeFile(
      join(directory, 'github-distribution.json'),
      JSON.stringify({ tag: 'acceptance-v0.1.2-bbbbbbbb' }),
    );
    await assert.rejects(acceptanceDistribution(directory, next));
    await writeFile(join(directory, 'github-distribution.json'), 'malformed');
    await assert.rejects(acceptanceDistribution(directory, { ...next, version: '0.1.1' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
