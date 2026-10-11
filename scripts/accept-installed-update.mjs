import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [basePackage, nextPackage, driverPath, edgeDriverPath, output] = process.argv.slice(2);
if (process.platform !== 'win32' || !output) throw new Error('Windows acceptance inputs required.');
await mkdir(output, { recursive: true });
const base = JSON.parse(await readFile(join(basePackage, 'package-info.json'), 'utf8'));
const next = JSON.parse(await readFile(join(nextPackage, 'package-info.json'), 'utf8'));
assert.equal(base.version, '0.1.0');
assert.equal(next.version, '0.1.1');
assert.equal(base.sourceCommit, next.sourceCommit);
const origin = 'https://downloads.aimansour.com';
const manifestResponse = await fetch(origin + '/updates/windows-x86_64-test.json');
assert.equal(manifestResponse.status, 200);
const manifest = await manifestResponse.json();
assert.equal(manifest.sourceCommit, next.sourceCommit);
assert.equal(manifest.version, next.version);
const publicInstaller = await fetch(manifest.platforms['windows-x86_64'].url);
assert.equal(publicInstaller.status, 200);
const publicBytes = Buffer.from(await publicInstaller.arrayBuffer());
assert.equal(publicBytes.length, next.bytes);
assert.equal(createHash('sha256').update(publicBytes).digest('hex'), next.sha256);
const installedDirectory = resolve(output, 'installed');
const install = spawnSync(
  join(resolve(basePackage), base.name),
  ['/S', '/D=' + installedDirectory],
  { timeout: 180000, windowsHide: true },
);
assert.equal(install.status, 0, 'Clean NSIS installation failed.');
const app = join(installedDirectory, 'mawjivo.exe');
await readFile(app);
const utility = resolve('apps/desktop/src-tauri/target/release/acceptance_data.exe');
function data(mode) {
  const result = spawnSync(utility, [mode], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Acceptance data utility failed.');
  return JSON.parse(result.stdout);
}
data('seed');
const driver = spawn(resolve(driverPath), ['--native-driver', resolve(edgeDriverPath)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let driverLog = '';
for (const stream of [driver.stdout, driver.stderr])
  stream.on('data', (chunk) => {
    driverLog = (driverLog + chunk).slice(-24000);
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let session;
async function request(path, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:4444' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error)
    throw new Error('WebDriver: ' + (result.value?.message ?? response.status));
  return result.value;
}
async function waitFor(operation, timeout = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await delay(500);
    }
  }
  throw last ?? new Error('Acceptance timeout');
}
async function open() {
  const value = await request('/session', 'POST', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: app } } },
  });
  session = value.sessionId;
}
const element = (xpath) =>
  request(`/session/${session}/element`, 'POST', { using: 'xpath', value: xpath }).then(
    (value) => value['element-6066-11e4-a52e-4f735466cecf'],
  );
const button = (text) => waitFor(() => element(`//button[normalize-space(.)='${text}']`));
async function click(text) {
  const id = await button(text);
  await request(`/session/${session}/element/${id}/click`, 'POST', {});
}
const visibleText = (text) =>
  waitFor(() => element(`//*[self::p or self::bdi][normalize-space(.)='${text}']`));
try {
  await waitFor(() => request('/status'));
  await open();
  const text = 'مسودة محفوظة بعد التحديث الموقّع';
  const textarea = await waitFor(() =>
    element("//textarea[@id=//label[normalize-space(.)='النص أو الوصف']/@for]"),
  );
  await request(`/session/${session}/element/${textarea}/value`, 'POST', { text });
  await waitFor(async () => assert.equal(data('probe').draftText, text));
  const before = data('probe');
  await click('الإعدادات');
  await click('التحديثات');
  await click('فحص التحديثات');
  await visibleText('0.1.1');
  await click('تنزيل التحديث');
  await visibleText('تم التحقق من التحديث. يمكنك تثبيته الآن.');
  const expectedBinaryHash = createHash('sha256')
    .update(await readFile('apps/desktop/src-tauri/target/release/mawjivo.exe'))
    .digest('hex');
  await click('تثبيت التحديث').catch((error) => {
    if (
      !/disconnected|invalid session|no such window|target window|connection/i.test(error.message)
    )
      throw error;
  });
  await waitFor(
    async () =>
      assert.equal(
        createHash('sha256')
          .update(await readFile(app))
          .digest('hex'),
        expectedBinaryHash,
      ),
    150000,
  );
  const after = data('probe');
  assert.equal(after.profileHash, before.profileHash);
  assert.equal(after.vaultHash, before.vaultHash);
  assert.equal(after.draftHash, before.draftHash);
  assert.ok(after.backupCount > before.backupCount);
  // Close only this installed acceptance executable before a fresh WebDriver session.
  const script =
    "$taskPath = '" +
    app.replaceAll("'", "''") +
    "'; Get-CimInstance Win32_Process -Filter \"Name = 'mawjivo.exe'\" | Where-Object { $_.ExecutablePath -eq $taskPath } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  await request(`/session/${session}`, 'DELETE').catch(() => {});
  await open();
  const restored = await waitFor(() =>
    element("//textarea[@id=//label[normalize-space(.)='النص أو الوصف']/@for]"),
  );
  assert.equal(await request(`/session/${session}/element/${restored}/property/value`), text);
  const proof = {
    sourceCommit: next.sourceCommit,
    cleanInstall: true,
    signedUpdateVerified: true,
    profilePreserved: true,
    draftPreserved: true,
    vaultPreserved: true,
    publicDownloadVerified: true,
    backupCreated: true,
    fromVersion: base.version,
    toVersion: next.version,
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(join(output, 'acceptance-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    'Clean NSIS install and real signed in-app update passed; profile, draft and Windows vault preserved.',
  );
} finally {
  if (session) await request(`/session/${session}`, 'DELETE').catch(() => {});
  driver.kill();
  await writeFile(join(output, 'driver.log'), driverLog);
}
