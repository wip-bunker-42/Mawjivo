import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { compareVersions } from './release-records.mjs';
import { hashFile, verifyReleasePackage } from './verify-release.mjs';
import { startWindowsAcceptanceSession } from './windows-session.mjs';

export function validateAcceptanceVersions(base, next) {
  try {
    if (
      !/^[a-f0-9]{40}$/.test(base.sourceCommit) ||
      base.sourceCommit !== next.sourceCommit ||
      compareVersions(base.version, next.version) >= 0
    )
      throw new Error();
  } catch {
    throw new Error('ACCEPTANCE_VERSION_INPUT');
  }
}
export async function requireFreshProductionNamespace(ci, directory) {
  if (!ci) throw new Error('ACCEPTANCE_CI_ONLY');
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error('ACCEPTANCE_OWNER_DATA');
}
export function makeAcceptanceProof(next, hashes, observations) {
  if (!/^[a-f0-9]{64}$/.test(hashes.installed ?? '') || hashes.installed !== hashes.reference)
    throw new Error('ACCEPTANCE_BINARY_MISMATCH');
  if (
    ![
      'cleanInstall',
      'signedUpdateVerified',
      'profilePreserved',
      'draftPreserved',
      'vaultPreserved',
    ].every((key) => observations[key] === true) ||
    !/^[a-f0-9]{40}$/.test(next.sourceCommit ?? '') ||
    !/^[a-f0-9]{64}$/.test(next.sha256 ?? '')
  )
    throw new Error('ACCEPTANCE_UNPROVEN');
  compareVersions(next.version, next.version);
  return {
    ...observations,
    sourceCommit: next.sourceCommit,
    packageVersion: next.version,
    packageSha256: next.sha256,
    installedBinarySha256: hashes.installed,
    referenceBinarySha256: hashes.reference,
    verifiedAt: new Date().toISOString(),
  };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(operation, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await delay(500);
    }
  }
  throw last ?? new Error('ACCEPTANCE_TIMEOUT');
}
async function installPackage(directory, metadata, destination) {
  const result = spawnSync(join(resolve(directory), metadata.name), ['/S', '/D=' + destination], {
    timeout: 180000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, 'Clean NSIS installation failed.');
  const app = join(destination, 'mawjivo.exe');
  await readFile(app);
  assert.deepEqual(
    (await readdir(destination)).filter((name) => name.endsWith('.exe')).sort(),
    ['mawjivo.exe', 'uninstall.exe'],
    'Operator/test executables must not be bundled.',
  );
  return app;
}
export async function acceptInstalledUpdate({
  basePackage,
  nextPackage,
  driverPath,
  edgeDriverPath,
  output,
  productionCandidate = false,
}) {
  if (process.platform !== 'win32' || !output)
    throw new Error('Windows acceptance inputs required.');
  const utility = resolve('apps/desktop/src-tauri/target/release/acceptance_data.exe');
  const dataEnv = {
    ...process.env,
    MAWJIVO_ACCEPTANCE_PRODUCTION_NAMESPACE: String(productionCandidate),
  };
  function data(mode) {
    const result = spawnSync(utility, [mode], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: dataEnv,
    });
    if (result.status !== 0) throw new Error(result.stderr || 'Acceptance data utility failed.');
    return JSON.parse(result.stdout);
  }
  // The native guard independently checks CI before creating any production data.
  if (productionCandidate) {
    if (!process.env.LOCALAPPDATA) throw new Error('ACCEPTANCE_OWNER_DATA');
    await requireFreshProductionNamespace(
      process.env.GITHUB_ACTIONS === 'true',
      join(process.env.LOCALAPPDATA, 'com.aimansour.mawjivo'),
    );
    data('assert-empty');
  }
  await mkdir(output, { recursive: true });
  let stage = 'verify-packages',
    active = null;
  const mark = (value) => {
    stage = value;
    console.log('Acceptance stage: ' + value);
  };
  const request = (...args) => active.request(...args);
  const element = (xpath) =>
    request(`/session/${active.sessionId}/element`, 'POST', { using: 'xpath', value: xpath }).then(
      (value) => value['element-6066-11e4-a52e-4f735466cecf'],
    );
  async function click(text) {
    const id = await waitFor(() => element(`//button[normalize-space(.)='${text}']`));
    await request(`/session/${active.sessionId}/element/${id}/click`, 'POST', {});
  }
  const visibleText = (text) =>
    waitFor(() => element(`//*[self::p or self::bdi][normalize-space(.)='${text}']`));
  const installedDirectory = resolve(output, 'installed');
  const open = async () => {
    active = await startWindowsAcceptanceSession({
      appPath: join(installedDirectory, 'mawjivo.exe'),
      driverPath,
      edgeDriverPath,
      output,
    });
  };
  try {
    const base = await verifyReleasePackage(basePackage, { channel: 'test' });
    const next = await verifyReleasePackage(nextPackage, {
      channel: productionCandidate ? 'production' : 'test',
    });
    validateAcceptanceVersions(base, next);
    mark('public-download');
    const response = await fetch(
      'https://downloads.aimansour.com/updates/windows-x86_64-test.json',
      { redirect: 'error', signal: AbortSignal.timeout(15000) },
    );
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.sourceCommit, next.sourceCommit);
    assert.equal(manifest.version, next.version);
    assert.equal(manifest.sha256, next.sha256);
    const publicUrl = new URL(manifest.platforms['windows-x86_64'].url);
    assert.equal(publicUrl.origin, 'https://downloads.aimansour.com');
    assert.equal(publicUrl.pathname, `/releases/${next.version}/${next.name}`);
    const download = await fetch(publicUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    assert.equal(download.status, 200);
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of download.body) {
      bytes += chunk.length;
      assert.ok(bytes <= next.bytes);
      digest.update(chunk);
    }
    assert.equal(bytes, next.bytes);
    assert.equal(digest.digest('hex'), next.sha256);
    mark('independent-clean-install');
    const reference = await installPackage(nextPackage, next, resolve(output, 'reference'));
    const expectedBinaryHash = await hashFile(reference);
    mark('baseline-clean-install');
    const app = await installPackage(basePackage, base, installedDirectory);
    mark('native-data-seed');
    data('seed');
    mark('open-installed-app');
    await open();
    mark('persist-draft');
    const text = 'مسودة محفوظة بعد التحديث الموقّع';
    const textarea = await waitFor(() =>
      element("//textarea[@id=//label[normalize-space(.)='النص أو الوصف']/@for]"),
    );
    await request(`/session/${active.sessionId}/element/${textarea}/value`, 'POST', { text });
    await waitFor(async () => assert.equal(data('probe').draftText, text));
    const before = data('probe');
    mark('check-update');
    await click('الإعدادات');
    await click('التحديثات');
    await click('فحص التحديثات');
    await visibleText(next.version);
    mark('download-and-verify-update');
    await click('تنزيل التحديث');
    await visibleText('تم التحقق من التحديث. يمكنك تثبيته الآن.');
    mark('install-update');
    await click('تثبيت التحديث').catch((error) => {
      if (
        !/disconnected|invalid session|no such window|target window|connection/i.test(error.message)
      )
        throw error;
    });
    await waitFor(async () => assert.equal(await hashFile(app), expectedBinaryHash), 150000);
    mark('verify-preserved-data');
    const after = data('probe');
    assert.equal(after.profileHash, before.profileHash);
    assert.equal(after.vaultHash, before.vaultHash);
    assert.equal(after.draftHash, before.draftHash);
    assert.ok(after.backupCount > before.backupCount);
    // The updater may have restarted the app. Close only this isolated executable.
    const script =
      "$taskPath = '" +
      app.replaceAll("'", "''") +
      "'; Get-CimInstance Win32_Process -Filter \"Name = 'mawjivo.exe'\" | Where-Object { $_.ExecutablePath -eq $taskPath } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    const stopped = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'pipe', timeout: 15000 },
    );
    assert.equal(stopped.status, 0);
    await active.close();
    active = null;
    mark('reopen-updated-app');
    await open();
    const restored = await waitFor(() =>
      element("//textarea[@id=//label[normalize-space(.)='النص أو الوصف']/@for]"),
    );
    assert.equal(
      await request(`/session/${active.sessionId}/element/${restored}/property/value`),
      text,
    );
    const proof = makeAcceptanceProof(
      next,
      { installed: await hashFile(app), reference: expectedBinaryHash },
      {
        cleanInstall: true,
        signedUpdateVerified: true,
        profilePreserved: true,
        draftPreserved: true,
        vaultPreserved: true,
        publicDownloadVerified: true,
        backupCreated: true,
        fromVersion: base.version,
        toVersion: next.version,
        productionCandidate,
      },
    );
    await writeFile(join(output, 'acceptance-proof.json'), JSON.stringify(proof, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      'Clean NSIS install and real signed in-app update passed; profile, draft and Windows vault preserved.',
    );
    return proof;
  } catch (error) {
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify({ stage, error: error.message }, null, 2) + '\n',
    );
    if (active) {
      await request(`/session/${active.sessionId}/source`)
        .then((source) => writeFile(join(output, 'failure.html'), source))
        .catch(() => {});
      await request(`/session/${active.sessionId}/screenshot`)
        .then((png) => writeFile(join(output, 'failure.png'), Buffer.from(png, 'base64')))
        .catch(() => {});
    }
    throw error;
  } finally {
    await active?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [basePackage, nextPackage, driverPath, edgeDriverPath, output, ...flags] =
    process.argv.slice(2);
  await acceptInstalledUpdate({
    basePackage,
    nextPackage,
    driverPath,
    edgeDriverPath,
    output,
    productionCandidate: flags.includes('--production-candidate'),
  });
}
