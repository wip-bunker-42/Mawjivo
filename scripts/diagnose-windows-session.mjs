import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const [basePackage, output, expectation] = process.argv.slice(2);
if (process.platform !== 'win32' || !output || process.env.GITHUB_ACTIONS !== 'true')
  throw new Error('WINDOWS_CI_DIAGNOSTIC_ONLY');
await mkdir(output, { recursive: true });
const info = JSON.parse(await readFile(join(basePackage, 'package-info.json'), 'utf8'));
const installed = resolve(output, 'installed');
const install = spawnSync(join(resolve(basePackage), info.name), ['/S', '/D=' + installed], {
  timeout: 180000,
  windowsHide: true,
});
if (install.status !== 0) throw new Error('DIAGNOSTIC_INSTALL_FAILED');
const app = join(installed, 'mawjivo.exe');
const child = spawn(app, [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    TAURI_AUTOMATION: 'true',
    TAURI_WEBVIEW_AUTOMATION: 'true',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1',
  },
});
let log = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (data) => {
    log = (log + data).slice(-16000);
  });
child.on('error', (error) => {
  log += '\n' + error.code;
});
let ready = false;
try {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version', {
        signal: AbortSignal.timeout(1000),
      });
      ready = response.ok && Boolean((await response.json()).webSocketDebuggerUrl);
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const script = `
    $taskProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('mawjivo.exe','msedgewebview2.exe','msedgedriver.exe','tauri-driver.exe') } | Select-Object Name,ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine);
    $taskConnections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 9222 -or $_.OwningProcess -in $taskProcesses.ProcessId } | Select-Object LocalAddress,LocalPort,OwningProcess);
    $taskPolicies = @('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge','HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge') | ForEach-Object { Get-ItemProperty -LiteralPath $_ -Name RemoteDebuggingAllowed -ErrorAction SilentlyContinue | Select-Object RemoteDebuggingAllowed };
    $taskElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    @{elevated=$taskElevated;processes=$taskProcesses;connections=$taskConnections;policies=@($taskPolicies);userDataDirectory=$env:LOCALAPPDATA;runtimeDirectory=$env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;inheritedWebviewArgs=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS} | ConvertTo-Json -Depth 6
  `;
  const diagnostics = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  await writeFile(
    join(output, 'startup.json'),
    JSON.stringify({ ready, exitCode: child.exitCode, appPath: app, log }, null, 2) + '\n',
  );
  await writeFile(join(output, 'environment.json'), diagnostics.stdout || '{}');
  console.log('DIAGNOSTIC_WEBVIEW_READY: ' + ready + '; childExitCode: ' + child.exitCode);
  if (expectation === '--expect-ready' && !ready) throw new Error('DIAGNOSTIC_WEBVIEW_NOT_READY');
} finally {
  child.kill();
}
