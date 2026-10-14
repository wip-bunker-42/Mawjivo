import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateAcceptanceVersions,
  requireFreshProductionNamespace,
  makeAcceptanceProof,
} from '../accept-installed-update.mjs';
const sourceCommit = 'a'.repeat(40);
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
