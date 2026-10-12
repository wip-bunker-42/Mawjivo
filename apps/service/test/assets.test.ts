import { beforeEach, expect, test, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { beginUpload, completeUpload, serveMedia, renewUpload, abortUpload } from '../src/assets';
import { resetTestData, testEnv, requestAs, ownerToken, limitedToken } from './helpers';
import { assetAuth, manifest, uploaded, postReference } from './asset-fixtures';
beforeEach(resetTestData);
test('local_r2_resumes_a_35_mb_fixture_and_keeps_successful_parts', async () => {
  const env = testEnv(),
    size = 35_000_000,
    partBytes = 16 * 1024 * 1024;
  const original = new Uint8Array(size);
  for (let i = 0; i < size; i++) original[i] = i % 251;
  const input = {
    ...manifest(size),
    kind: 'video' as const,
    mimeType: 'video/mp4',
    durationMs: 180_000,
  };
  const first = await beginUpload(assetAuth, 'workspace-a', input, env);
  const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
    .bind(first.assetId)
    .first<{ object_key: string }>();
  const multipart = env.MEDIA.resumeMultipartUpload(row!.object_key, first.multipartId!);
  const send = vi.spyOn(multipart, 'uploadPart');
  const part1 = await multipart.uploadPart(1, original.subarray(0, partBytes));
  // The client loses its connection before part 2. Its durable ledger retains part 1's opaque ETag.
  const resumed = await renewUpload(assetAuth, first.assetId, env, [2, 3]);
  expect(resumed.assetId).toBe(first.assetId);
  expect(resumed.multipartId).toBe(first.multipartId);
  expect(resumed.parts.map((part) => part.partNumber)).toEqual([2, 3]);
  const part2 = await multipart.uploadPart(2, original.subarray(partBytes, 2 * partBytes));
  const part3 = await multipart.uploadPart(3, original.subarray(2 * partBytes));
  const hash = (bytes: Uint8Array) =>
    crypto.subtle
      .digest('SHA-256', bytes)
      .then((value) =>
        Array.from(new Uint8Array(value), (n) => n.toString(16).padStart(2, '0')).join(''),
      );
  const sha256 = await hash(original);
  const asset = await completeUpload(assetAuth, first.assetId, [part1, part2, part3], sha256, env);
  expect(send.mock.calls.map(([n]) => n)).toEqual([1, 2, 3]);
  expect(asset.bytes).toBe(size);
  const object = await env.MEDIA.get(row!.object_key);
  expect(await hash(new Uint8Array(await object!.arrayBuffer()))).toBe(sha256);
  expect((await beginUpload(assetAuth, 'workspace-a', input, env)).parts).toEqual([]);
}, 30_000);
test('concurrent_reservations_cannot_exceed_9000000000', async () => {
  const env = testEnv();
  const outcomes = await Promise.allSettled(
    [1, 2, 3, 4].map((n) =>
      beginUpload(
        assetAuth,
        'workspace-a',
        {
          ...manifest(3_000_000_000),
          sourceAssetId: 'source-' + n,
          kind: 'video',
          mimeType: 'video/mp4',
          durationMs: 180_000,
        },
        env,
      ),
    ),
  );
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(bytes),0) AS bytes FROM assets WHERE state!='deleted'",
  ).first<{ bytes: number }>();
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
  expect(row!.bytes).toBe(6_000_000_000);
  expect(row!.bytes + 1_000_000_000).toBeLessThanOrEqual(9_000_000_000);
});
test('scoped_upload_routes_support_renew_abort_and_public_media', async () => {
  const begun = await exports.default.fetch(
    requestAs(ownerToken, '/api/workspaces/workspace-a/assets', manifest()),
  );
  expect(begun.status).toBe(201);
  const ticket = (await begun.json()) as { assetId: string; parts: { url: string }[] };
  const url = new URL(ticket.parts[0]!.url);
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(url.href).not.toContain('test-secret');
  const renew = await exports.default.fetch(
    requestAs(ownerToken, `/api/workspaces/workspace-a/assets/${ticket.assetId}/renew`, {
      partNumbers: [1],
    }),
  );
  expect(renew.status).toBe(200);
  const foreign = await exports.default.fetch(
    requestAs(limitedToken, `/api/workspaces/workspace-b/assets/${ticket.assetId}/renew`, {
      partNumbers: [1],
    }),
  );
  expect(foreign.status).toBe(403);
  const cancel = await exports.default.fetch(
    requestAs(
      ownerToken,
      `/api/workspaces/workspace-a/assets/${ticket.assetId}`,
      undefined,
      'DELETE',
    ),
  );
  expect(cancel.status).toBe(204);
  const total = await testEnv()
    .DB.prepare("SELECT SUM(bytes) AS bytes FROM assets WHERE state!='deleted'")
    .first<{ bytes: number | null }>();
  expect(total!.bytes ?? 0).toBe(0);
  const { asset } = await uploaded();
  const alias = await postReference(asset.id);
  const response = await exports.default.fetch(new Request('https://service.test' + alias.path));
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(10);
});
test('idempotent_begin_and_complete_reuse_one_object', async () => {
  const env = testEnv(),
    input = manifest(),
    first = await beginUpload(assetAuth, 'workspace-a', input, env),
    second = await beginUpload(assetAuth, 'workspace-a', input, env);
  expect(first.assetId).toBe(second.assetId);
  expect(first.multipartId).toBe(second.multipartId);
  const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
    .bind(first.assetId)
    .first<{ object_key: string }>();
  const mp = env.MEDIA.resumeMultipartUpload(row!.object_key, first.multipartId!);
  const part = await mp.uploadPart(1, new Uint8Array(10));
  const a = await completeUpload(assetAuth, first.assetId, [part], 'b'.repeat(64), env),
    b = await completeUpload(assetAuth, first.assetId, [part], 'b'.repeat(64), env);
  expect(a).toEqual(b);
});
test('foreign_complete_is_forbidden_before_r2_access', async () => {
  const env = testEnv(),
    ticket = await beginUpload(assetAuth, 'workspace-b', manifest(), env);
  const head = vi.spyOn(env.MEDIA, 'head');
  try {
    await expect(
      completeUpload(
        { deviceId: 'limited', allowedWorkspaceIds: ['workspace-a'] },
        ticket.assetId,
        [],
        'a'.repeat(64),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(head).not.toHaveBeenCalled();
  } finally {
    head.mockRestore();
  }
});
test('jpeg_url_decodes_to_original_name_and_range_returns_four_bytes', async () => {
  const { asset } = await uploaded();
  const alias = await postReference(asset.id);
  expect(decodeURIComponent(alias.path.split('/').at(-1)!)).toBe('صورتي العربية.jpg');
  const response = await serveMedia(
    new Request('https://media.test' + alias.path, { headers: { Range: 'bytes=2-5' } }),
    alias.nonce,
    'صورتي العربية.jpg',
    testEnv(),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
  expect(response.headers.get('Content-Length')).toBe('4');
  expect((await response.arrayBuffer()).byteLength).toBe(4);
  expect(response.headers.get('Content-Type')).toBe('image/jpeg');
  expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");
});
test('video_alias_does_not_copy_r2_object', async () => {
  const env = testEnv(),
    { asset } = await uploaded('workspace-a', {
      ...manifest(),
      kind: 'video',
      mimeType: 'video/mp4',
      originalName: 'source.mp4',
      durationMs: 1000,
    });
  const put = vi.spyOn(env.MEDIA, 'put');
  try {
    const alias = await postReference(asset.id, 'published', 'published', 'عنوان الفيديو.mp4');
    expect(decodeURIComponent(alias.path.split('/').at(-1)!)).toBe('عنوان الفيديو.mp4');
    expect(put).not.toHaveBeenCalled();
  } finally {
    put.mockRestore();
  }
});
test('complete_requires_actual_size_to_match_manifest', async () => {
  const env = testEnv(),
    ticket = await beginUpload(assetAuth, 'workspace-a', manifest(20), env);
  const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
    .bind(ticket.assetId)
    .first<{ object_key: string }>();
  const mp = env.MEDIA.resumeMultipartUpload(row!.object_key, ticket.multipartId!),
    part = await mp.uploadPart(1, new Uint8Array(10));
  await expect(
    completeUpload(assetAuth, ticket.assetId, [part], 'a'.repeat(64), env),
  ).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
  expect(await env.MEDIA.head(row!.object_key)).toBeNull();
});
test('head_returns_full_metadata_and_conditional_weak_etag_is_304', async () => {
  const { asset } = await uploaded(),
    alias = await postReference(asset.id),
    env = testEnv();
  const head = await serveMedia(
    new Request('https://media.test' + alias.path, {
      method: 'HEAD',
      headers: { Range: 'bytes=2-5' },
    }),
    alias.nonce,
    'صورتي العربية.jpg',
    env,
  );
  expect(head.status).toBe(200);
  expect(head.headers.get('Content-Length')).toBe('10');
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  const conditional = await serveMedia(
    new Request('https://media.test' + alias.path, {
      headers: { 'If-None-Match': 'W/' + head.headers.get('ETag') },
    }),
    alias.nonce,
    'صورتي العربية.jpg',
    env,
  );
  expect(conditional.status).toBe(304);
  expect((await conditional.arrayBuffer()).byteLength).toBe(0);
  const bad = await serveMedia(
    new Request('https://media.test' + alias.path, { headers: { Range: 'bytes=10-12' } }),
    alias.nonce,
    'صورتي العربية.jpg',
    env,
  );
  expect(bad.status).toBe(416);
});
test('large_upload_presigns_bounded_batches_and_renews_same_reservation', async () => {
  const env = testEnv(),
    ticket = await beginUpload(
      assetAuth,
      'workspace-a',
      { ...manifest(500_000_000), kind: 'video', mimeType: 'video/mp4' },
      env,
    );
  expect(ticket.parts).toHaveLength(16);
  const next = await renewUpload(assetAuth, ticket.assetId, env, [17, 18, 19]);
  expect(next.multipartId).toBe(ticket.multipartId);
  expect(next.parts.map((p) => p.partNumber)).toEqual([17, 18, 19]);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM upload_reservations WHERE asset_id=?',
  )
    .bind(ticket.assetId)
    .first<{ count: number }>();
  expect(count!.count).toBe(1);
  await expect(renewUpload(assetAuth, ticket.assetId, env, [1000])).rejects.toMatchObject({
    code: 'INVALID_UPLOAD_PARTS',
  });
  await abortUpload(assetAuth, ticket.assetId, env);
});
test('failed_abort_cannot_release_capacity_before_confirmed_retry', async () => {
  const env = testEnv(),
    ticket = await beginUpload(assetAuth, 'workspace-a', manifest(), env);
  const resume = env.MEDIA.resumeMultipartUpload.bind(env.MEDIA),
    spy = vi.spyOn(env.MEDIA, 'resumeMultipartUpload').mockImplementation((key, id) => {
      const real = resume(key, id);
      return {
        key,
        uploadId: id,
        uploadPart: real.uploadPart.bind(real),
        complete: real.complete.bind(real),
        abort: async () => {
          throw new Error('synthetic abort outage');
        },
      };
    });
  try {
    await expect(abortUpload(assetAuth, ticket.assetId, env)).rejects.toThrow();
    const reserve = await env.DB.prepare('SELECT state FROM upload_reservations WHERE asset_id=?')
      .bind(ticket.assetId)
      .first<{ state: string }>();
    expect(reserve!.state).toBe('active');
  } finally {
    spy.mockRestore();
  }
  await abortUpload(assetAuth, ticket.assetId, env);
  const released = await env.DB.prepare('SELECT state FROM upload_reservations WHERE asset_id=?')
    .bind(ticket.assetId)
    .first<{ state: string }>();
  expect(released!.state).toBe('released');
});

test('real_r2_complete_response_without_metadata_is_verified_using_stored_object_head', async () => {
  const env = testEnv();
  const ticket = await beginUpload(
    assetAuth,
    'workspace-a',
    { ...manifest(), kind: 'video', mimeType: 'video/mp4' },
    env,
  );
  const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
    .bind(ticket.assetId)
    .first<{ object_key: string }>();
  const multipart = env.MEDIA.resumeMultipartUpload(row!.object_key, ticket.multipartId!);
  const part = await multipart.uploadPart(1, new Uint8Array(10));
  const original = env.MEDIA.resumeMultipartUpload.bind(env.MEDIA);
  const resume = vi.spyOn(env.MEDIA, 'resumeMultipartUpload').mockImplementation((key, id) => {
    const upload = original(key, id);
    return {
      key,
      uploadId: id,
      uploadPart: upload.uploadPart.bind(upload),
      abort: upload.abort.bind(upload),
      complete: async (parts) => {
        const result = await upload.complete(parts);
        // Production R2 completes with empty metadata, although HEAD retains it.
        return {
          ...result,
          size: result.size,
          httpMetadata: {},
          customMetadata: {},
          writeHttpMetadata: result.writeHttpMetadata.bind(result),
        };
      },
    };
  });
  try {
    const completed = await completeUpload(assetAuth, ticket.assetId, [part], 'a'.repeat(64), env);
    expect(completed.bytes).toBe(10);
    expect(completed.mimeType).toBe('video/mp4');
    const stored = await env.MEDIA.head(row!.object_key);
    expect(stored!.customMetadata!.assetId).toBe(ticket.assetId);
    expect(
      await env.DB.prepare('SELECT state FROM upload_reservations WHERE asset_id=?')
        .bind(ticket.assetId)
        .first('state'),
    ).toBe('completed');
  } finally {
    resume.mockRestore();
  }
});

test.each(['contentType', 'assetId'] as const)(
  'multipart_confirmation_still_rejects_wrong_stored_%s',
  async (field) => {
    const env = testEnv();
    const ticket = await beginUpload(assetAuth, 'workspace-a', manifest(), env);
    const row = await env.DB.prepare('SELECT object_key FROM assets WHERE id=?')
      .bind(ticket.assetId)
      .first<{ object_key: string }>();
    const upload = env.MEDIA.resumeMultipartUpload(row!.object_key, ticket.multipartId!);
    const part = await upload.uploadPart(1, new Uint8Array(10));
    const original = env.MEDIA.head.bind(env.MEDIA);
    const head = vi.spyOn(env.MEDIA, 'head').mockImplementation(async (key) => {
      const result = await original(key);
      if (!result) return null;
      return {
        ...result,
        size: result.size,
        httpMetadata:
          field === 'contentType' ? { contentType: 'video/mp4' } : (result.httpMetadata ?? {}),
        customMetadata:
          field === 'assetId' ? { assetId: 'foreign-object' } : (result.customMetadata ?? {}),
        writeHttpMetadata: result.writeHttpMetadata.bind(result),
      };
    });
    try {
      await expect(
        completeUpload(assetAuth, ticket.assetId, [part], 'a'.repeat(64), env),
      ).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
    } finally {
      head.mockRestore();
    }
    expect(await env.MEDIA.head(row!.object_key)).toBeNull();
  },
);
