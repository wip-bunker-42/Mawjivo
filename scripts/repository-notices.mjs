import { createHash } from 'node:crypto';

const inventories = new WeakMap();
async function boundedText(response, limit) {
  if (!response.ok) throw new Error('Pinned source request failed (' + response.status + ').');
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('Pinned source exceeds its size limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function repositoryNotices({ repository, vcs, fetcher = fetch }) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
    repository ?? '',
  );
  const revision = vcs?.git?.sha1;
  const sourcePath = vcs?.path_in_vcs ?? '';
  if (
    !match ||
    !/^[a-f0-9]{40}$/.test(revision ?? '') ||
    !/^(?:[\w.-]+\/)*[\w.-]*$/.test(sourcePath) ||
    sourcePath.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('A verified repository revision is required for missing notices.');
  const repositoryPath = match[1] + '/' + match[2];
  const treeUrl = `https://api.github.com/repos/${repositoryPath}/git/trees/${revision}?recursive=1`;
  let cache = inventories.get(fetcher);
  if (!cache) {
    cache = new Map();
    inventories.set(fetcher, cache);
  }
  if (!cache.has(treeUrl)) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Mawjivo-license-inventory',
    };
    if (fetcher === fetch && process.env.GITHUB_TOKEN)
      headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    cache.set(
      treeUrl,
      (async () => {
        const result = JSON.parse(
          await boundedText(
            await fetcher(treeUrl, {
              headers,
              redirect: 'error',
              signal: AbortSignal.timeout(15_000),
            }),
            8 * 1024 * 1024,
          ),
        );
        if (result.truncated !== false || !Array.isArray(result.tree))
          throw new Error('Incomplete pinned source inventory.');
        return result.tree.filter((item) => item.type === 'blob').map((item) => item.path);
      })(),
    );
  }
  const paths = await cache.get(treeUrl);
  const segments = sourcePath ? sourcePath.split('/') : [];
  let licenses = [];
  for (let count = segments.length; count >= 0; count--) {
    const prefix = count ? segments.slice(0, count).join('/') + '/' : '';
    licenses = paths.filter((path) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
      const relative = path.slice(prefix.length);
      return /^(?:(?:licenses?|licences?)\/)?(?:licen[sc]e|copying|notice|copyright)(?:[._-][\w.-]+)?$/i.test(
        relative,
      );
    });
    if (licenses.length) break;
  }
  if (!licenses.length) throw new Error('No license files found at the pinned source revision.');
  const notices = [];
  for (const path of licenses.sort()) {
    const url = `https://raw.githubusercontent.com/${repositoryPath}/${revision}/${path}`;
    const text = await boundedText(
      await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }),
      128 * 1024,
    );
    if (!text.trim()) throw new Error('Empty pinned license file.');
    notices.push({ path, url, text, sha256: createHash('sha256').update(text).digest('hex') });
  }
  return notices;
}
