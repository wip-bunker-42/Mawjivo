import { spawn, spawnSync } from 'node:child_process';
import { realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createServer } from 'node:net';

function shell(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  );
  if (result.status !== 0) throw new Error('WINDOWS_DIAGNOSTIC_FAILED');
  return result.stdout.trim();
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function validate(input) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  const binaryPath = await realpath(input.appPath);
  if (basename(binaryPath).toLowerCase() !== 'mawjivo.exe' || !(await stat(binaryPath)).isFile())
    throw new Error('WINDOWS_BINARY_PATH');
  await realpath(input.driverPath);
  await realpath(input.edgeDriverPath);
  const folder = process.env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER;
  if (!folder) throw new Error('WINDOWS_RUNTIME_MISSING');
  const runtime = await realpath(join(folder, 'msedgewebview2.exe'));
  const runtimeVersion = shell(
    `[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${runtime.replaceAll("'", "''")}').ProductVersion`,
  );
  const driver = spawnSync(resolve(input.edgeDriverPath), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  const driverVersion = driver.stdout?.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  if (driver.status !== 0 || !driverVersion || !/^\d+\.\d+\.\d+\.\d+$/.test(runtimeVersion))
    throw new Error('WINDOWS_RUNTIME_MISMATCH');
  return { binaryPath, runtimeVersion, driverVersion };
}
export async function startWindowsAcceptanceSession(input, overrides = {}) {
  const children = [],
    logs = [];
  let sessionId = null,
    driverPort = null,
    sessionTimeout = 15000;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(path === '/session' ? sessionTimeout : 10000),
    });
    const value = await response.json();
    if (!response.ok || value.value?.error) throw new Error('WINDOWS_WEBDRIVER_SESSION');
    return value.value;
  };
  const dependencies = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    validate,
    port: freePort,
    launchApp: (path, port) =>
      spawn(path, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          TAURI_AUTOMATION: 'true',
          TAURI_WEBVIEW_AUTOMATION: 'true',
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
        },
      }),
    launchDriver: (port) =>
      spawn(resolve(input.edgeDriverPath), [`--port=${port}`, '--host=127.0.0.1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    inspectApp: async (pid) => ({
      binaryPath: shell(
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`,
      ),
    }),
    probe: async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      const info = await response.json();
      if (!response.ok || !info.webSocketDebuggerUrl) throw new Error('WINDOWS_WEBVIEW_NOT_READY');
      return {
        browserVersion: info.Browser?.match(/\d+\.\d+\.\d+\.\d+/)?.[0],
        webSocketDebuggerUrl: info.webSocketDebuggerUrl,
      };
    },
    createSession: async (port) =>
      request('/session', 'POST', {
        capabilities: {
          alwaysMatch: {
            'ms:edgeChromium': true,
            browserName: 'webview2',
            'ms:edgeOptions': { debuggerAddress: `127.0.0.1:${port}` },
          },
        },
      }),
    request,
    diagnostics: async () => {
      try {
        return JSON.parse(
          shell(
            "@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('mawjivo.exe','msedgewebview2.exe','msedgedriver.exe')} | Select-Object Name,ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine) | ConvertTo-Json -Depth 3",
          ),
        );
      } catch {
        return { unavailable: true };
      }
    },
    writeDiagnostic: async (value) => {
      await mkdir(input.output, { recursive: true });
      await writeFile(
        join(input.output, 'session-failure.json'),
        JSON.stringify(value, null, 2) + '\n',
      );
    },
    ...overrides,
  };
  async function close() {
    if (sessionId) await dependencies.request(`/session/${sessionId}`, 'DELETE').catch(() => {});
    for (const child of children.reverse()) child.kill();
  }
  let verified;
  try {
    verified = await dependencies.validate(input);
    if (verified.runtimeVersion !== verified.driverVersion)
      throw new Error('WINDOWS_RUNTIME_MISMATCH');
    const port = await dependencies.port();
    driverPort = await dependencies.port();
    const app = dependencies.launchApp(verified.binaryPath, port),
      driver = dependencies.launchDriver(driverPort);
    children.push(app, driver);
    let spawnFailure = null;
    for (const child of children) {
      child.on('error', (error) => {
        spawnFailure = error.code ?? 'SPAWN_FAILED';
      });
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk) => {
          logs.push(String(chunk).slice(-8000));
          if (logs.length > 4) logs.shift();
        });
    }
    const deadline = dependencies.now() + 60000;
    let webview;
    const actual = await dependencies.inspectApp(app.pid);
    if (
      actual.binaryPath.replaceAll('\\', '/').toLowerCase() !==
      verified.binaryPath.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('WINDOWS_BINARY_PATH');
    while (dependencies.now() < deadline) {
      if (spawnFailure) throw new Error('WINDOWS_APP_SPAWN_FAILED');
      if (app.exitCode !== null) throw new Error('WINDOWS_APP_EXITED');
      if (driver.exitCode !== null) throw new Error('WINDOWS_DRIVER_EXITED');
      try {
        webview = await dependencies.probe(port);
        break;
      } catch {}
      await dependencies.sleep(500);
    }
    if (!webview) throw new Error('WINDOWS_WEBVIEW_TIMEOUT');
    if (webview.browserVersion !== verified.runtimeVersion)
      throw new Error('WINDOWS_RUNTIME_MISMATCH');
    sessionTimeout = Math.max(1, Math.min(15000, deadline - dependencies.now()));
    const session = await dependencies.createSession(port);
    if (!session?.sessionId) throw new Error('WINDOWS_WEBDRIVER_SESSION');
    sessionId = session.sessionId;
    if (dependencies.now() >= deadline) throw new Error('WINDOWS_WEBVIEW_TIMEOUT');
    return { sessionId, binaryPath: verified.binaryPath, request: dependencies.request, close };
  } catch (error) {
    await dependencies
      .writeDiagnostic({
        error: error.message,
        runtime: verified ?? null,
        logs,
        processes: await dependencies.diagnostics(),
      })
      .catch(() => {});
    await close();
    throw error;
  }
}
