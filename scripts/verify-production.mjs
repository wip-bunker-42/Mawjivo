import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const platforms = ['facebook', 'instagram', 'threads', 'x', 'youtube', 'tiktok'];
export async function verifyProduction(input, io) {
  const findings = [];
  const add = (code, messageAr) => findings.push({ code, messageAr });
  let readyPlatforms = 0,
    mediaVerified = 0;
  const read = (path) => io.read({ profileId: input.profileId, method: 'GET', path });
  try {
    const health = await io.probe({ url: input.baseUrl + '/health', method: 'GET' });
    if (health.status !== 200 || health.body?.state !== 'ready')
      add('SERVICE_NOT_READY', 'خدمة Cloudflare لم تكتمل جاهزيتها.');
    const monitoring = await read('/api/monitoring');
    if (
      !monitoring.configured ||
      !monitoring.lastCheckedAt ||
      monitoring.readiness?.some((item) => item.state !== 'ready')
    )
      add('MONITORING_NOT_READY', 'راجع مراقبة الخدمة وانتظر تسجيل نبض ناجح.');
    const workspaces = await read('/api/workspaces');
    if (!Array.isArray(workspaces) || !workspaces.length)
      add('WORKSPACE_MISSING', 'أضف مساحة عمل واربط حساباتها.');
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      const caps = await read('/api/workspaces/' + workspace.id + '/capabilities');
      const ready = new Set(
        (caps.channels ?? [])
          .filter((channel) => channel.ready && channel.limits?.supportedKinds?.length)
          .map((channel) => channel.platform),
      );
      readyPlatforms += platforms.filter((platform) => ready.has(platform)).length;
      if (platforms.some((platform) => !ready.has(platform)))
        add(
          'PLATFORMS_INCOMPLETE',
          'بعض المنصات تحتاج ربطًا أو إصلاح الصلاحيات. راجع حسابات النشر.',
        );
      const telegram = await read('/api/workspaces/' + workspace.id + '/telegram');
      if (!telegram.configured)
        add('TELEGRAM_NOT_READY', 'أضف بوت تليجرام ومحادثة التقارير لهذه المساحة.');
    }
  } catch {
    add('SERVICE_READ_FAILED', 'تعذر قراءة الخدمة. راجع اتصال الجهاز وعنوان الخدمة.');
  }
  if (!input.mediaUrls?.length)
    add('MEDIA_NOT_VERIFIED', 'لم يُختبر رابط وسائط في هذه الخدمة بعد.');
  for (const url of input.mediaUrls ?? []) {
    let valid = false;
    try {
      const parsed = new URL(url);
      valid =
        parsed.origin === new URL(input.baseUrl).origin &&
        /^\/media\/[a-f0-9]{64}\/[^/]+$/.test(parsed.pathname) &&
        !parsed.search &&
        !parsed.hash;
    } catch {}
    if (!valid) {
      add('MEDIA_SCOPE', 'رابط الوسائط لا ينتمي لخدمة الحساب المختارة.');
      continue;
    }
    try {
      const head = await io.probe({ url, method: 'HEAD' }),
        get = await io.probe({ url, method: 'GET' }),
        range = await io.probe({ url, method: 'GET', headers: { Range: 'bytes=0-3' } });
      const bytes = Number(head.headers['content-length']);
      if (
        head.status !== 200 ||
        get.status !== 200 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 4 ||
        !get.bytes ||
        Number(get.headers['content-length']) !== bytes ||
        range.status !== 206 ||
        range.headers['content-range'] !== 'bytes 0-3/' + bytes ||
        range.bytes !== 4
      )
        throw new Error('Delivery mismatch');
      mediaVerified++;
    } catch {
      add('MEDIA_DELIVERY_FAILED', 'رابط الوسائط أو طلب جزء منه لم يعمل كما يجب.');
    }
  }
  return {
    verifiedAt: new Date().toISOString(),
    passed: findings.length === 0,
    readyPlatforms,
    mediaVerified,
    findings,
  };
}
async function probe(request) {
  const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    }),
    headers = Object.fromEntries(response.headers);
  if (new URL(request.url).pathname === '/health')
    return { status: response.status, headers, body: await response.json(), bytes: 0 };
  let bytes = 0;
  if (request.method !== 'HEAD' && response.body) {
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      bytes = first.value?.length ?? 0;
    } finally {
      await reader.cancel();
    }
  }
  return { status: response.status, headers, bytes };
}
async function cli() {
  const selected = process.argv.slice(2).filter((value) => value !== '--')[0];
  if (!selected) throw new Error('حدد owner أو معرف الحساب المحلي.');
  const state = JSON.parse(await readFile('.mawjivo-operator/owner-provision-state.json', 'utf8'));
  if (selected !== 'owner' && selected !== state.profile.id)
    throw new Error('الحساب لا يطابق ملف الإعداد المحلي.');
  const media = await readFile('.mawjivo-operator/owner-media-proof-input.json', 'utf8')
    .then(JSON.parse)
    .catch(() => []);
  const report = await verifyProduction(
    { profileId: state.profile.id, baseUrl: state.profile.baseUrl, mediaUrls: media },
    {
      probe,
      read: (request) => {
        const result = spawnSync(
          resolve(
            process.env.MAWJIVO_OPERATOR_EXE ?? 'apps/desktop/src-tauri/target/debug/setup.exe',
          ),
          ['--request'],
          {
            input: JSON.stringify(request),
            encoding: 'utf8',
            windowsHide: true,
            timeout: 45000,
            maxBuffer: 1048576,
          },
        );
        if (result.status !== 0) throw new Error('تعذر قراءة الخدمة من خزنة الجهاز.');
        return JSON.parse(result.stdout);
      },
    },
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await cli().catch(() => {
    console.error('تعذر الفحص؛ راجع ملف الحساب المحلي وخدمة Cloudflare.');
    process.exitCode = 1;
  });
