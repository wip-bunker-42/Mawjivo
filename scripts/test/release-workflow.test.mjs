import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseWorkflowInputs } from '../operator-release.mjs';
const sourceCommit = 'a'.repeat(40),
  projectVersion = '0.1.1';
const common = { sourceCommit, projectVersion, defaultBranch: 'abdo/initial' };
test('the actual workflow CLI appends validated outputs without needing publishing dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-workflow-cli-'));
  try {
    const output = join(directory, 'outputs');
    await writeFile(output, 'previous=preserved\n');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const tag = `acceptance-v${pkg.version}-${sourceCommit.slice(0, 8)}`;
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../operator-release.mjs', import.meta.url)), '--workflow-inputs'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_SHA: sourceCommit,
          GITHUB_REF: `refs/tags/${tag}`,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          MAWJIVO_DEFAULT_BRANCH: 'abdo/initial',
          MAWJIVO_WORKFLOW_INPUTS: JSON.stringify({ mode: 'acceptance' }),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const saved = await readFile(output, 'utf8');
    assert.ok(saved.startsWith('previous=preserved\n'));
    assert.ok(saved.includes(`tag=${tag}\n`));
    assert.ok(saved.includes('mode=acceptance\n'));
    assert.equal(JSON.parse(result.stdout).version, pkg.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('production requires a stable matching version tag and exact source', () => {
  assert.equal(
    releaseWorkflowInputs({ ...common, eventName: 'push', ref: 'refs/tags/v0.1.1', inputs: {} })
      .mode,
    'production',
  );
  for (const ref of ['refs/heads/abdo/mawjivo-app', 'refs/tags/v0.1.1-rc.1', 'refs/tags/v0.1.0'])
    assert.throws(
      () =>
        releaseWorkflowInputs({
          ...common,
          eventName: 'workflow_dispatch',
          ref,
          inputs: { mode: 'production' },
        }),
      /RELEASE_WORKFLOW_INPUT/,
    );
});
test('acceptance names its own source-bound test tag and never enables production', () => {
  const result = releaseWorkflowInputs({
    ...common,
    eventName: 'workflow_dispatch',
    ref: 'refs/tags/acceptance-v0.1.1-aaaaaaaa',
    inputs: { mode: 'acceptance' },
  });
  assert.equal(result.mode, 'acceptance');
  assert.equal(result.tag, 'acceptance-v0.1.1-aaaaaaaa');
  assert.throws(
    () =>
      releaseWorkflowInputs({
        ...common,
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/abdo/mawjivo-app',
        inputs: { mode: 'acceptance' },
      }),
    /RELEASE_WORKFLOW_INPUT/,
  );
});
test('cleanup schedule runs only from the default branch and replay is a diagnostic mode', () => {
  assert.equal(
    releaseWorkflowInputs({
      ...common,
      eventName: 'schedule',
      ref: 'refs/heads/abdo/initial',
      inputs: {},
    }).mode,
    'cleanup',
  );
  assert.throws(
    () =>
      releaseWorkflowInputs({
        ...common,
        eventName: 'schedule',
        ref: 'refs/heads/abdo/mawjivo-app',
        inputs: {},
      }),
    /RELEASE_WORKFLOW_INPUT/,
  );
  assert.equal(
    releaseWorkflowInputs({
      ...common,
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/abdo/mawjivo-app',
      inputs: { replay_run: '38159292394' },
    }).mode,
    'replay',
  );
  assert.throws(
    () =>
      releaseWorkflowInputs({
        ...common,
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/abdo/mawjivo-app',
        inputs: { replay_run: 'not-a-run' },
      }),
    /RELEASE_WORKFLOW_INPUT/,
  );
});
test('diagnostic options without a completed run id are refused before any build', () => {
  for (const inputs of [
    { mode: 'replay' },
    { mode: 'acceptance', diagnostics_only: true },
    { mode: 'acceptance', production_candidate_replay: true },
  ]) {
    assert.throws(
      () =>
        releaseWorkflowInputs({
          ...common,
          eventName: 'workflow_dispatch',
          ref: 'refs/tags/acceptance-v0.1.1-aaaaaaaa',
          inputs,
        }),
      /RELEASE_WORKFLOW_INPUT/,
    );
  }
});
test('GitHub-only release workflow scopes publication permissions and keeps one uncancelled publisher', async () => {
  const file = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(file, /schedule:/);
  assert.match(file, /tags:\s*\[\s*['"]v\*['"]\s*\]/);
  assert.match(file, /cancel-in-progress: false/);
  assert.match(file, /archive:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.match(file, /needs:\s*\[resolve, acceptance\]/);
  assert.match(file, /github-release\.mjs/);
  assert.doesNotMatch(
    file,
    /publish-release\.mjs|publish-acceptance-candidate\.mjs|MAWJIVO_RELEASE_SECRET_KEY|MAWJIVO_RELEASE_ACCESS_KEY_ID/,
  );
  assert.match(file, /needs\.resolve\.outputs\.mode == 'production'/);
  assert.match(file, /github-release\.mjs --stage/);
  assert.doesNotMatch(file, /path:[\s\S]*?\*\.secrets\.env/);
  assert.doesNotMatch(file, /\.tools\/test-signature\/\s*\n/);
});
