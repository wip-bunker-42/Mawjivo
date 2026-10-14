import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateAcceptanceVersions,
  requireFreshProductionNamespace,
  makeAcceptanceProof,
  readAcceptanceProof,
} from '../accept-installed-update.mjs';
const sourceCommit = 'a'.repeat(40);
test('a successful launcher exit cannot replace missing or incomplete installed-update evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-proof-gate-'));
  const packageInfo = { version: '0.1.1', sourceCommit, sha256: 'c'.repeat(64) };
  try {
    const path = join(directory, 'acceptance-proof.json');
    await assert.rejects(readAcceptanceProof(path, packageInfo), /ACCEPTANCE_PROOF_MISSING/);
    const valid = {
      sourceCommit,
      packageVersion: '0.1.1',
      packageSha256: 'c'.repeat(64),
      installedBinarySha256: 'd'.repeat(64),
      referenceBinarySha256: 'd'.repeat(64),
      cleanInstall: true,
      signedUpdateVerified: true,
      profilePreserved: true,
      draftPreserved: true,
      vaultPreserved: true,
      publicDownloadVerified: true,
      backupCreated: true,
      productionCandidate: true,
      fromVersion: '0.1.0',
      toVersion: '0.1.1',
    };
    for (const change of [
      { vaultPreserved: false },
      { sourceCommit: 'b'.repeat(40) },
      { packageSha256: 'e'.repeat(64) },
      { referenceBinarySha256: 'e'.repeat(64) },
      { productionCandidate: false },
      { backupCreated: false },
    ]) {
      await writeFile(path, JSON.stringify({ ...valid, ...change }));
      await assert.rejects(
        readAcceptanceProof(path, packageInfo),
        /ACCEPTANCE_UNPROVEN|ACCEPTANCE_BINARY_MISMATCH/,
      );
    }
    await writeFile(path, JSON.stringify(valid));
    assert.equal((await readAcceptanceProof(path, packageInfo)).packageVersion, '0.1.1');
    await writeFile(path, JSON.stringify({ ...valid, productionCandidate: false }));
    assert.equal((await readAcceptanceProof(path, packageInfo, false)).productionCandidate, false);
    await writeFile(join(directory, 'package-info.json'), JSON.stringify(packageInfo));
    const script = fileURLToPath(new URL('../accept-installed-update.mjs', import.meta.url));
    const cli = (flags) =>
      spawnSync(process.execPath, [script, '--verify-proof', path, directory, ...flags], {
        encoding: 'utf8',
        windowsHide: true,
      });
    assert.equal(cli([]).status, 1);
    const legacy = cli(['--legacy-replay']);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(JSON.parse(legacy.stdout).verified, true);
    await writeFile(
      path,
      JSON.stringify({ ...valid, productionCandidate: false, vaultPreserved: false }),
    );
    await assert.rejects(readAcceptanceProof(path, packageInfo, false), /ACCEPTANCE_UNPROVEN/);
    assert.equal(cli(['--legacy-replay']).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('acceptance works for later version pairs and rejects equal, older or foreign source inputs', () => {
  assert.doesNotThrow(() =>
    validateAcceptanceVersions(
      { version: '0.5.0', sourceCommit },
      { version: '0.7.1', sourceCommit },
    ),
  );
  for (const next of [
    { version: '0.5.0', sourceCommit },
    { version: '0.4.9', sourceCommit },
    { version: '0.7.1', sourceCommit: 'b'.repeat(40) },
  ])
    assert.throws(
      () => validateAcceptanceVersions({ version: '0.5.0', sourceCommit }, next),
      /ACCEPTANCE_VERSION_INPUT/,
    );
});
test('production acceptance refuses a local machine and any existing production data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mawjivo-prod-guard-'));
  try {
    await assert.rejects(
      requireFreshProductionNamespace(false, join(directory, 'empty')),
      /ACCEPTANCE_CI_ONLY/,
    );
    await writeFile(join(directory, 'owner.sqlite'), 'owner data');
    await assert.rejects(requireFreshProductionNamespace(true, directory), /ACCEPTANCE_OWNER_DATA/);
    await requireFreshProductionNamespace(true, join(directory, 'fresh'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('proof compares installed and independent reference binaries while binding the separate installer digest', () => {
  const next = { version: '0.7.1', sourceCommit, sha256: 'c'.repeat(64) };
  const observations = {
    cleanInstall: true,
    signedUpdateVerified: true,
    profilePreserved: true,
    draftPreserved: true,
    vaultPreserved: true,
  };
  const proof = makeAcceptanceProof(
    next,
    { installed: 'd'.repeat(64), reference: 'd'.repeat(64) },
    observations,
  );
  assert.equal(proof.packageSha256, next.sha256);
  assert.equal(proof.packageVersion, next.version);
  assert.equal(proof.installedBinarySha256, proof.referenceBinarySha256);
  assert.notEqual(proof.installedBinarySha256, proof.packageSha256);
  assert.throws(
    () =>
      makeAcceptanceProof(
        next,
        { installed: 'd'.repeat(64), reference: 'e'.repeat(64) },
        observations,
      ),
    /ACCEPTANCE_BINARY_MISMATCH/,
  );
  assert.throws(
    () =>
      makeAcceptanceProof(
        next,
        { installed: 'd'.repeat(64), reference: 'd'.repeat(64) },
        { ...observations, vaultPreserved: false },
      ),
    /ACCEPTANCE_UNPROVEN/,
  );
});
