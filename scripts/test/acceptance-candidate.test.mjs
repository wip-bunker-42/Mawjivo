import test from 'node:test';
import assert from 'node:assert/strict';
import { publishAcceptanceCandidate } from '../publish-acceptance-candidate.mjs';
const directory = 'C:/candidate',
  testSignaturePath = 'C:/isolated/test.sig';
function fixture(fail = false) {
  const calls = [];
  const release = {
    channel: 'production',
    version: '0.1.1',
    sourceCommit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    objects: [
      { key: 'releases/0.1.1/candidate.exe', path: 'C:/candidate/candidate.exe' },
      { key: 'releases/0.1.1/candidate.exe.sig', path: 'C:/candidate/candidate.exe.sig' },
    ],
    manifest: {
      version: '0.1.1',
      platforms: {
        'windows-x86_64': {
          url: 'https://downloads.aimansour.com/releases/0.1.1/candidate.exe',
          signature: 'production-signature',
        },
      },
    },
  };
  return {
    calls,
    release,
    deps: {
      verifyPackage: async (path, options) => {
        calls.push(['verify-package', options.channel]);
        return release;
      },
      readSignature: async () => 'test-signature',
      verifyTestSignature: async (input) => {
        calls.push(['verify-test', input.installerPath, input.signaturePath]);
        if (fail) throw new Error('RELEASE_SIGNATURE_INVALID');
      },
      stage: async (value) => {
        calls.push(['stage', value]);
        return { release: value, verifiedObjectKeys: value.objects.map((o) => o.key) };
      },
      activate: async (value, proof) => {
        calls.push(['activate', value, proof]);
        return { activated: 'test' };
      },
    },
  };
}
test('acceptance stages canonical production files and changes only the test manifest inline signature', async () => {
  const f = fixture();
  assert.deepEqual(await publishAcceptanceCandidate({ directory, testSignaturePath }, {}, f.deps), {
    activated: 'test',
  });
  assert.equal(f.calls[0][1], 'production');
  assert.equal(f.calls[1][0], 'verify-test');
  const staged = f.calls.find((c) => c[0] === 'stage')[1],
    activated = f.calls.find((c) => c[0] === 'activate')[1];
  assert.equal(staged, f.release);
  assert.equal(activated.release.channel, 'test');
  assert.deepEqual(activated.release.objects, f.release.objects);
  assert.equal(activated.release.manifest.platforms['windows-x86_64'].signature, 'test-signature');
  assert.equal(f.release.manifest.platforms['windows-x86_64'].signature, 'production-signature');
  assert.equal(f.calls.find((c) => c[0] === 'activate')[2], null);
});
test('invalid supplemental signature never stages or activates a candidate', async () => {
  const f = fixture(true);
  await assert.rejects(
    publishAcceptanceCandidate({ directory, testSignaturePath }, {}, f.deps),
    /RELEASE_SIGNATURE_INVALID/,
  );
  assert.ok(f.calls.every((c) => !['stage', 'activate'].includes(c[0])));
});
