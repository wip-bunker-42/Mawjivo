import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseWorkflowInputs } from '../operator-release.mjs';
const sourceCommit = 'a'.repeat(40),
  projectVersion = '0.1.1';
const common = { sourceCommit, projectVersion, defaultBranch: 'abdo/initial' };
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
test('release workflow limits write permissions to archive publishing and keeps one uncancelled publisher', async () => {
  const file = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  assert.match(file, /schedule:/);
  assert.match(file, /tags:\s*\[\s*['"]v\*['"]\s*\]/);
  assert.match(file, /cancel-in-progress: false/);
  assert.match(file, /archive:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.match(file, /needs:\s*\[resolve, acceptance\]/);
  assert.match(file, /github-release\.mjs/);
  assert.match(file, /publish-release\.mjs/);
  assert.match(file, /needs\.resolve\.outputs\.mode == 'production'/);
  assert.ok(
    file.indexOf('Archive the proven signed package') <
      file.indexOf('Activate the proven production update'),
  );
  assert.doesNotMatch(file, /path:[\s\S]*?\*\.secrets\.env/);
  assert.doesNotMatch(file, /\.tools\/test-signature\/\s*\n/);
});
