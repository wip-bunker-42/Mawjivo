import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../download-worker.mjs';
const origin = 'https://downloads.aimansour.com';
test('a private repository test update is anonymously readable on its independent uncached channel', async () => {
  const manifest = {
    version: '0.1.1',
    platforms: {
      'windows-x86_64': {
        url: origin + '/releases/0.1.1/Mawjivo-Acceptance.exe',
        signature: 'public-signature',
      },
    },
  };
  const request = new Request(origin + '/updates/windows-x86_64-test.json');
  assert.equal(request.headers.get('Authorization'), null);
  const response = await worker.fetch(request, {
    RELEASES: {
      async get(key) {
        assert.equal(key, 'updates/windows-x86_64-test.json');
        return {
          size: 1,
          body: JSON.stringify(manifest),
          httpEtag: '"test"',
          writeHttpMetadata(h) {
            h.set('Content-Type', 'application/json');
          },
        };
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), manifest);
});
test('anonymous download access is limited to published release paths and never permits writes', async () => {
  let calls = 0;
  const env = {
    RELEASES: {
      get() {
        calls++;
      },
      head() {
        calls++;
      },
    },
  };
  for (const [path, method] of [
    ['/mawjivo-release-owner.json', 'GET'],
    ['/mawjivo.secrets.env', 'GET'],
    ['/releases/0.1.0/Mawjivo.exe', 'POST'],
  ]) {
    const response = await worker.fetch(new Request(origin + path, { method }), env);
    assert.ok([404, 405].includes(response.status));
  }
  assert.equal(calls, 0);
});
test('a range download streams exact bytes and describes the partial response', async () => {
  const response = await worker.fetch(
    new Request(origin + '/releases/0.1.0/Mawjivo.exe', { headers: { Range: 'bytes=0-1' } }),
    {
      RELEASES: {
        async get(key, options) {
          assert.equal(key, 'releases/0.1.0/Mawjivo.exe');
          assert.equal(options.range.get('Range'), 'bytes=0-1');
          return {
            size: 4,
            range: { offset: 0, length: 2 },
            body: 'Ma',
            httpEtag: '"abc"',
            writeHttpMetadata(h) {
              h.set('Content-Type', 'application/octet-stream');
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-1/4');
  assert.equal(response.headers.get('Content-Length'), '2');
  assert.equal(await response.text(), 'Ma');
});
test('source archives allow HEAD without reading their body', async () => {
  const response = await worker.fetch(
    new Request(origin + '/media-tools/9.0.2-mawjivo/media-tools-sources.zip', { method: 'HEAD' }),
    {
      RELEASES: {
        get() {
          throw new Error('Do not download a source body for HEAD');
        },
        async head() {
          return {
            size: 180000000,
            httpEtag: '"sources"',
            writeHttpMetadata(h) {
              h.set('Content-Type', 'application/zip');
            },
          };
        },
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '180000000');
  assert.equal(await response.text(), '');
});
