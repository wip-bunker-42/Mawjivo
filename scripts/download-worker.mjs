const publishedPath =
  /^\/(?:releases\/[0-9][A-Za-z0-9.-]{0,63}\/[A-Za-z0-9_.-]{1,180}\.(?:exe|zip|sig|json|txt)|media-tools\/[0-9][A-Za-z0-9.-]{0,100}\/(?:media-tools-win32-x64\.zip|media-tools-sources\.zip|manifest\.json)|updates\/(?:windows-x86_64|latest)\.json)$/;
export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const path = new URL(request.url).pathname;
    if (!publishedPath.test(path)) return new Response('Not found', { status: 404 });
    const range = request.headers.get('Range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range))
      return new Response('Invalid range', { status: 416 });
    try {
      const object =
        request.method === 'HEAD'
          ? await env.RELEASES.head(path.slice(1))
          : await env.RELEASES.get(path.slice(1), range ? { range: request.headers } : {});
      if (!object) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set(
        'Cache-Control',
        path.startsWith('/updates/') ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      const partial = request.method === 'GET' && object.range;
      headers.set('Content-Length', String(partial ? object.range.length : object.size));
      if (partial)
        headers.set(
          'Content-Range',
          `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
        );
      return new Response(request.method === 'HEAD' ? null : object.body, {
        status: partial ? 206 : 200,
        headers,
      });
    } catch {
      return new Response(range ? 'Range unavailable' : 'Download temporarily unavailable', {
        status: range ? 416 : 503,
      });
    }
  },
};
