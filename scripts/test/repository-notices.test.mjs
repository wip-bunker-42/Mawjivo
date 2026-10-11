import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositoryNotices } from '../repository-notices.mjs';

const revision = '0123456789abcdef0123456789abcdef01234567';
test('missing crate notices come from its exact source revision and preserve complete license text', async () => {
  const calls = [];
  const texts = new Map([
    ['LICENSE-MIT', 'Copyright fixture authors\nPermission to use this fixture.\n'],
    ['LICENSE-APACHE', 'Apache fixture terms\nComplete fixture text.\n'],
  ]);
  const notices = await repositoryNotices({
    repository: 'https://github.com/fixture-owner/fixture-project',
    vcs: { git: { sha1: revision }, path_in_vcs: 'crates/subpackage' },
    fetcher: async (url) => {
      calls.push(url);
      if (
        url ===
        `https://api.github.com/repos/fixture-owner/fixture-project/git/trees/${revision}?recursive=1`
      )
        return Response.json({
          truncated: false,
          tree: [
            { type: 'blob', path: 'LICENSE-MIT' },
            { type: 'blob', path: 'LICENSE-APACHE' },
            { type: 'blob', path: 'other-crate/LICENSE' },
          ],
        });
      return new Response(texts.get(new URL(url).pathname.split('/').at(-1)), { status: 200 });
    },
  });
  assert.deepEqual(notices.map((notice) => notice.text).sort(), [...texts.values()].sort());
  assert.ok(notices.every((notice) => /^[a-f0-9]{64}$/.test(notice.sha256)));
  assert.ok(calls.every((url) => url.includes(revision)));
  assert.equal(calls.length, 3);
});

test('crate licenses directory wins over an unrelated ancestor license', async () => {
  const notices = await repositoryNotices({
    repository: 'https://github.com/fixture-owner/fixture-project',
    vcs: { git: { sha1: revision }, path_in_vcs: 'crates/subpackage' },
    fetcher: async (url) =>
      url.startsWith('https://api.github.com/')
        ? Response.json({
            truncated: false,
            tree: [
              { type: 'blob', path: 'LICENSE' },
              { type: 'blob', path: 'crates/subpackage/licenses/LICENSE-BSD.txt' },
            ],
          })
        : new Response('The complete BSD fixture license.'),
  });
  assert.deepEqual(
    notices.map((notice) => notice.path),
    ['crates/subpackage/licenses/LICENSE-BSD.txt'],
  );
});

test('unversioned repositories and incomplete inventories fail without fetching guessed license text', async () => {
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return Response.json({ truncated: true, tree: [] });
  };
  await assert.rejects(
    repositoryNotices({
      repository: 'https://github.com/fixture-owner/fixture-project',
      vcs: { git: { sha1: 'main' } },
      fetcher,
    }),
  );
  assert.equal(requests, 0);
  await assert.rejects(
    repositoryNotices({
      repository: 'https://github.com/fixture-owner/fixture-project',
      vcs: { git: { sha1: revision }, path_in_vcs: '' },
      fetcher,
    }),
  );
  assert.equal(requests, 1);
});
