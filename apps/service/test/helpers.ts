import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { inject } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-plugin';
declare module 'vitest' {
  interface ProvidedContext {
    migrations: D1Migration[];
  }
}
export const ownerToken = 'test-owner-device-token-000000';
export const limitedToken = 'test-limited-device-token-00000';
export const revokedToken = 'test-revoked-device-token-00000';
export function testEnv(): Env {
  return env;
}
export function requestAs(
  deviceToken: string,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Request {
  return new Request('https://service.test' + path, {
    method,
    headers: { Authorization: 'Bearer ' + deviceToken, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function independentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function resetTestData(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, inject('migrations'));
  for (const [id, token, allowed, revoked] of [
    ['owner', ownerToken, '"*"', null],
    ['limited', limitedToken, '["workspace-a"]', null],
    ['revoked', revokedToken, '"*"', 1],
  ] as const) {
    await env.DB.prepare(
      'INSERT INTO devices(id,token_hash,allowed_workspace_ids,revoked_at_ms,created_at_ms) VALUES(?,?,?,?,?)',
    )
      .bind(id, await independentHash(token), allowed, revoked, 1)
      .run();
  }
  for (const id of ['workspace-a', 'workspace-b'])
    await env.DB.prepare(
      'INSERT INTO workspaces(id,name,time_zone,version,default_platforms,service_profile_id,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,1,1)',
    )
      .bind(id, id, 'Africa/Cairo', '["x"]', 'profile-1')
      .run();
}
