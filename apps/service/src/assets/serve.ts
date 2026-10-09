import type { AssetRow } from './model';
function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
function disposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
function rangeFor(header: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length < 1) return null;
    return { offset: Math.max(0, size - length), length: Math.min(size, length) };
  }
  const start = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
export async function serveMedia(
  request: Request,
  nonce: string,
  filename: string,
  env: Env,
): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (!/^[a-f0-9]{64}$/.test(nonce)) return notFound();
  const row = await env.DB.prepare(
    "SELECT a.* FROM asset_uses u JOIN assets a ON a.id=u.asset_id AND a.workspace_id=u.workspace_id WHERE u.alias_nonce=? AND u.sent_name=? AND a.state='complete'",
  )
    .bind(nonce, filename)
    .first<AssetRow>();
  if (!row) return notFound();
  let range: { offset: number; length: number } | undefined;
  const header = request.method === 'GET' ? request.headers.get('Range') : null;
  if (header !== null) {
    const parsed = rangeFor(header, row.bytes);
    if (!parsed)
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${row.bytes}`, 'Cache-Control': 'no-store' },
      });
    range = parsed;
  }
  const ifRange = request.headers.get('If-Range');
  if (range && ifRange) {
    const head = await env.MEDIA.head(row.object_key);
    if (!head) return notFound();
    const date = Date.parse(ifRange);
    if (
      ifRange !== head.httpEtag &&
      (!Number.isFinite(date) ||
        Math.floor(date / 1000) < Math.floor(head.uploaded.getTime() / 1000))
    )
      range = undefined;
  }
  const ifNoneMatch = request.headers.get('If-None-Match');
  const onlyIf = ifNoneMatch
    ? new Headers({
        'If-None-Match': ifNoneMatch
          .split(',')
          .map((tag) => tag.trim().replace(/^W\//, ''))
          .join(', '),
      })
    : undefined;
  const object =
    request.method === 'HEAD'
      ? await env.MEDIA.head(row.object_key)
      : await env.MEDIA.get(row.object_key, {
          ...(range ? { range } : {}),
          ...(onlyIf ? { onlyIf } : {}),
        });
  if (!object || object.size !== row.bytes || object.customMetadata?.assetId !== row.id)
    return notFound();
  const headers = new Headers({
    'Content-Type': row.mime_type,
    'Content-Length': String(range?.length ?? object.size),
    'Content-Disposition': disposition(filename),
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  const body = 'body' in object ? (object as R2ObjectBody).body : null;
  if (
    request.headers
      .get('If-None-Match')
      ?.split(',')
      .some((tag) => tag.trim().replace(/^W\//, '') === object.httpEtag || tag.trim() === '*')
  ) {
    await body?.cancel();
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (range)
    headers.set(
      'Content-Range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
  return new Response(body, { status: range ? 206 : 200, headers });
}
