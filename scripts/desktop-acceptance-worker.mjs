export default {
  async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const path = new URL(request.url).pathname;
    let body;
    if (path === '/api/workspaces')
      body = [
        {
          id: 'acceptance-space',
          name: 'مساحة اختبار التحديث',
          timeZone: 'Africa/Cairo',
          version: 1,
          defaultPlatforms: [],
          preferredChannels: {},
          serviceProfileId: 'acceptance-profile',
        },
      ];
    else if (path === '/api/workspaces/acceptance-space/capabilities')
      body = {
        version: 'acceptance-capabilities',
        fetchedAt: new Date().toISOString(),
        channels: [],
      };
    else return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};
