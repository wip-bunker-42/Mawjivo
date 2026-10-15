import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { compareVersions } from './release-records.mjs';
import { hashFile, verifyReleasePackage } from './verify-release.mjs';
import { startWindowsAcceptanceSession } from './windows-session.mjs';

export async function readAcceptanceProof(path, packageInfo, productionCandidate = true) {
  let proof;
  try {
    proof = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('ACCEPTANCE_PROOF_MISSING');
  }
  if (
    !proof ||
    proof.sourceCommit !== packageInfo.sourceCommit ||
    proof.packageVersion !== packageInfo.version ||
    proof.packageSha256 !== packageInfo.sha256 ||
    proof.productionCandidate !== productionCandidate ||
    proof.publicDownloadVerified !== true ||
    proof.backupCreated !== true ||
    proof.toVersion !== packageInfo.version ||
    compareVersions(proof.fromVersion, proof.toVersion) >= 0
  )
    throw new Error('ACCEPTANCE_UNPROVEN');
  makeAcceptanceProof(
    packageInfo,
    {
      installed: proof.installedBinarySha256,
      reference: proof.referenceBinarySha256,
    },
    proof,
  );
  return proof;
}

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
export async function acceptanceDistribution(directory, next) {
  const distribution = JSON.parse(
    await readFile(join(directory, 'github-distribution.json'), 'utf8'),
  );
  assert.ok(
    [`v${next.version}`, `acceptance-v${next.version}-${next.sourceCommit.slice(0, 8)}`].includes(
      distribution.tag,
    ),
  );
  const releasePath = `/wip-bunker-42/Mawjivo/releases/download/${distribution.tag}/`;
  return {
    manifestUrl: 'https://github.com' + releasePath + 'update-test.json',
    origin: 'https://github.com',
    pathname: releasePath + next.name,
    redirect: 'follow',
  };
}
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
  const exitDiagnostic = (code) => {
    try {
      writeFileSync(join(output, 'process-exit.json'), JSON.stringify({ code, stage }));
    } catch {}
  };
  process.on('exit', exitDiagnostic);
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
  function installerDiagnostics() {
    const script = `
      $taskProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('mawjivo.exe','msedgedriver.exe') -or $_.ExecutablePath -match 'Mawjivo-.+-(updater|installer)' } | ForEach-Object {
        $taskWindow = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;
        [pscustomobject]@{Name=$_.Name;ProcessId=$_.ProcessId;ExecutablePath=$_.ExecutablePath;CommandLine=$_.CommandLine;WindowTitle=$taskWindow.MainWindowTitle}
      });
      $taskRegistry = @('Registry32','Registry64') | ForEach-Object {
        $taskView = [Microsoft.Win32.RegistryView]::$_;
        $taskHive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$taskView);
        $taskProduct = $taskHive.OpenSubKey('Software\\Mawjivo\\Mawjivo');
        $taskUninstall = $taskHive.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mawjivo');
        [pscustomobject]@{View=$_;ProductDirectory=if($taskProduct){$taskProduct.GetValue('')};InstallerLanguage=if($taskProduct){$taskProduct.GetValue('Installer Language')};InstallLocation=if($taskUninstall){$taskUninstall.GetValue('InstallLocation')};Version=if($taskUninstall){$taskUninstall.GetValue('DisplayVersion')}};
        if($taskProduct){$taskProduct.Dispose()};if($taskUninstall){$taskUninstall.Dispose()};$taskHive.Dispose();
      };
      @{processes=$taskProcesses;registry=@($taskRegistry)} | ConvertTo-Json -Depth 5
    `;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1048576 },
    );
    return result.status === 0 ? result.stdout : JSON.stringify({ unavailable: true });
  }
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
    const distribution = await acceptanceDistribution(nextPackage, next);
    const response = await fetch(distribution.manifestUrl, {
      redirect: distribution.redirect,
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const manifest = await response.json();
    assert.equal(manifest.sourceCommit, next.sourceCommit);
    assert.equal(manifest.version, next.version);
    assert.equal(manifest.sha256, next.sha256);
    const publicUrl = new URL(manifest.platforms['windows-x86_64'].url);
    assert.equal(publicUrl.origin, distribution.origin);
    assert.equal(publicUrl.pathname, distribution.pathname);
    const download = await fetch(publicUrl, {
      redirect: distribution.redirect,
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
    await writeFile(join(output, 'before-install-diagnostics.json'), installerDiagnostics());
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
    mark('native-settings-dialogs');
    const dialogs = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        resolve('scripts/accept-settings-dialogs.ps1'),
        '-ApplicationPath',
        app,
        '-OutputPath',
        resolve(output, 'transfer-dialog-proof.json'),
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(
      dialogs.status,
      0,
      'Actual native settings file dialogs failed: ' + dialogs.stderr,
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
    await writeFile(join(output, 'native-diagnostics.json'), installerDiagnostics()).catch(
      () => {},
    );
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
    process.removeListener('exit', exitDiagnostic);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--verify-proof') {
    const proof = await readAcceptanceProof(
      process.argv[3],
      JSON.parse(await readFile(join(process.argv[4], 'package-info.json'), 'utf8')),
      !process.argv.includes('--legacy-replay'),
    );
    console.log(
      JSON.stringify({
        verified: true,
        sourceCommit: proof.sourceCommit,
        packageVersion: proof.packageVersion,
        packageSha256: proof.packageSha256,
      }),
    );
  } else {
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
}
