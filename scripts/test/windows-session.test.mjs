import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startWindowsAcceptanceSession } from '../windows-session.mjs';
const input = {
  appPath: 'C:/isolated/mawjivo.exe',
  driverPath: 'C:/tools/tauri-driver.exe',
  edgeDriverPath: 'C:/tools/msedgedriver.exe',
  output: 'C:/isolated/evidence',
};
function fake(options = {}) {
  let time = 0,
    probes = 0;
  const writes = [],
    children = [];
  const launch = () => {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 123,
      exitCode: options.exited ? 1 : null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        child.killed = true;
      },
    });
    children.push(child);
    return child;
  };
  return {
    writes,
    children,
    dependencies: {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      validate: async () => ({
        binaryPath: input.appPath,
        runtimeVersion: options.mismatch ? '155.0.1.1' : '155.0.2.1',
        driverVersion: '155.0.2.1',
      }),
      port: async () => 9222,
      launchApp: launch,
      launchDriver: launch,
      inspectApp: async () => ({
        binaryPath: options.foreign ? 'C:/another/mawjivo.exe' : input.appPath,
      }),
      probe: async () => {
        probes++;
        if (options.noWebView || probes < 2) throw new Error('ECONNREFUSED');
        return {
          browserVersion: '155.0.2.1',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
        };
      },
      createSession: async () => ({ sessionId: 'test-session' }),
      request: async () => null,
      diagnostics: async () => ({ processes: [] }),
      writeDiagnostic: async (value) => writes.push(value),
    },
  };
}
test('an alive process without a WebView session times out without a success proof', async () => {
  const fixture = fake({ noWebView: true });
  await assert.rejects(
    startWindowsAcceptanceSession(input, fixture.dependencies),
    /WINDOWS_WEBVIEW_TIMEOUT/,
  );
  assert.equal(fixture.writes.length, 1);
  assert.ok(fixture.children.every((child) => child.killed));
});
test('an exited application cannot become a successful WebView session', async () => {
  const fixture = fake({ exited: true });
  await assert.rejects(
    startWindowsAcceptanceSession(input, fixture.dependencies),
    /WINDOWS_APP_EXITED/,
  );
  assert.equal(fixture.writes.length, 1);
});
test('a mismatched Runtime and EdgeDriver are rejected before launch', async () => {
  const fixture = fake({ mismatch: true });
  await assert.rejects(
    startWindowsAcceptanceSession(input, fixture.dependencies),
    /WINDOWS_RUNTIME_MISMATCH/,
  );
  assert.equal(fixture.children.length, 0);
});
test('a process from another executable path never receives an acceptance session', async () => {
  const fixture = fake({ foreign: true });
  await assert.rejects(
    startWindowsAcceptanceSession(input, fixture.dependencies),
    /WINDOWS_BINARY_PATH/,
  );
});
test('a proven live session returns the exact installed binary and closes only owned children', async () => {
  const fixture = fake();
  const session = await startWindowsAcceptanceSession(input, fixture.dependencies);
  assert.equal(session.sessionId, 'test-session');
  assert.equal(session.binaryPath, input.appPath);
  assert.equal(fixture.writes.length, 0);
  await session.close();
  assert.ok(fixture.children.every((child) => child.killed));
});
test('a session that completes after the startup deadline is rejected and closed', async () => {
  const fixture = fake();
  fixture.dependencies.createSession = async () => {
    await fixture.dependencies.sleep(60001);
    return { sessionId: 'late-session' };
  };
  await assert.rejects(
    startWindowsAcceptanceSession(input, fixture.dependencies),
    /WINDOWS_WEBVIEW_TIMEOUT/,
  );
  assert.ok(fixture.children.every((child) => child.killed));
});
