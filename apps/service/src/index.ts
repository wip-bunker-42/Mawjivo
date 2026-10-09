export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/health') {
      return Response.json({ state: 'unconfigured', messageAr: 'أكمل إعداد الخدمة قبل النشر.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ code: 'NOT_FOUND', messageAr: 'الصفحة غير موجودة.' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
