import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { inject, expect, test } from 'vitest';

test('upgrading an existing service preserves scheduled post identifiers, due times and encrypted connections', async () => {
  await reset();
  const migrations = inject('migrations');
  await applyD1Migrations(env.DB, migrations.slice(0, 5));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,time_zone,version,default_platforms,service_profile_id,created_at_ms,updated_at_ms) VALUES('upgrade-space','مساحتي','Africa/Cairo',1,'[\"x\"]','profile-1',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO connections(id,workspace_id,provider,label,secret_cipher,updated_at_ms) VALUES('connection-preserved','upgrade-space','buffer','حسابي','encrypted-existing-value',1)",
    ),
    env.DB.prepare(
      "INSERT INTO channels(id,workspace_id,connection_id,remote_id,platform,provider,ready,limits_json,discovered_at_ms) VALUES('channel-1','upgrade-space','connection-preserved','remote-1','x','buffer',1,'{}',1)",
    ),
    env.DB.prepare(
      "INSERT INTO posts(id,workspace_id,draft_id,revision,plan_hash,plan_json,state,due_at_ms,created_at_ms,updated_at_ms,workflow_id) VALUES('post-preserved','upgrade-space','draft-1',1,'hash','{}','scheduled',1791788400000,1,1,'workflow-preserved')",
    ),
    env.DB.prepare(
      "INSERT INTO targets(post_id,revision,channel_id,workspace_id,state,updated_at_ms) VALUES('post-preserved',1,'channel-1','upgrade-space','ready',1)",
    ),
    env.DB.prepare(
      "INSERT INTO dispatch_outbox(id,post_id,revision,workflow_id,action,state,next_attempt_ms) VALUES('dispatch-preserved','post-preserved',1,'workflow-preserved','create','pending',1791788400000)",
    ),
  ]);
  const before = await env.DB.prepare(
    "SELECT p.id postId,p.due_at_ms dueAt,p.workflow_id workflowId,c.id connectionId,c.secret_cipher secretCipher FROM posts p JOIN connections c ON c.workspace_id=p.workspace_id WHERE p.id='post-preserved'",
  ).first();
  await applyD1Migrations(env.DB, migrations);
  const after = await env.DB.prepare(
    "SELECT p.id postId,p.due_at_ms dueAt,p.workflow_id workflowId,c.id connectionId,c.secret_cipher secretCipher FROM posts p JOIN connections c ON c.workspace_id=p.workspace_id WHERE p.id='post-preserved'",
  ).first();
  expect(after).toEqual(before);
  expect(after?.postId).toBe('post-preserved');
  expect(after?.dueAt).toBe(1791788400000);
  expect(after?.connectionId).toBe('connection-preserved');
  const dispatch = await env.DB.prepare(
    "SELECT post_id,workflow_id,state,receipts_only FROM dispatch_outbox WHERE id='dispatch-preserved'",
  ).first();
  expect(dispatch).toEqual({
    post_id: 'post-preserved',
    workflow_id: 'workflow-preserved',
    state: 'pending',
    receipts_only: 0,
  });
});
