import { decryptSecret } from '../secrets';
import { ServiceError } from '../errors';
export type BudgetPurpose = 'publish' | 'receipt' | 'discovery';
export type BudgetDecision =
  { kind: 'allowed'; reservationId: string } | { kind: 'deferred'; retryAt: string };
interface WindowBudget {
  policy: string;
  quota: number;
  seconds: number;
  remaining: number;
  resetAt: number;
  observedAt: number;
}
interface BudgetState {
  windows: WindowBudget[];
  pending: Record<string, { count: number; at: number }>;
  blockedUntil: number;
}
interface Row {
  state_json: string;
  version: number;
}
const policies = [
  [100, 900],
  [250, 86400],
  [3000, 2592000],
] as const;
async function clientIdentity(connectionId: string, env: Env): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT workspace_id,secret_cipher,key_version,provider FROM connections WHERE id=?',
  )
    .bind(connectionId)
    .first<{
      workspace_id: string;
      secret_cipher: string;
      key_version: number;
      provider: string;
    }>();
  if (!row || row.provider !== 'buffer')
    throw new ServiceError('CONNECTION_NOT_FOUND', 'حساب Buffer غير موجود.', 404);
  const credentials = JSON.parse(
    await decryptSecret(
      row.secret_cipher,
      { workspaceId: row.workspace_id, connectionId, keyVersion: row.key_version },
      env,
    ),
  ) as { apiKey?: string };
  if (!credentials.apiKey) throw new ServiceError('CONNECTION_INVALID', 'أعد ربط حساب Buffer.');
  // Scope the fingerprint to this service's encryption key, rather than store a reusable API-key hash.
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(env.SERVICE_ENCRYPTION_KEY + '\0' + credentials.apiKey),
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
function fresh(now: number): BudgetState {
  return {
    windows: policies.map(([quota, seconds]) => ({
      policy: String(seconds),
      quota,
      seconds,
      remaining: quota,
      resetAt: now + seconds * 1000,
      observedAt: 0,
    })),
    pending: {},
    blockedUntil: 0,
  };
}
async function rowFor(client: string, now: number, env: Env): Promise<Row> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO provider_budgets(client_id,state_json,version) VALUES(?,?,1)',
  )
    .bind(client, JSON.stringify(fresh(now)))
    .run();
  const row = await env.DB.prepare(
    'SELECT state_json,version FROM provider_budgets WHERE client_id=?',
  )
    .bind(client)
    .first<Row>();
  if (!row) throw new ServiceError('BUDGET_UNAVAILABLE', 'تعذر التحقق من حصة الحساب.', 503, true);
  return row;
}
async function save(client: string, row: Row, state: BudgetState, env: Env): Promise<boolean> {
  return (
    (
      await env.DB.prepare(
        'UPDATE provider_budgets SET state_json=?,version=version+1 WHERE client_id=? AND version=?',
      )
        .bind(JSON.stringify(state), client, row.version)
        .run()
    ).meta.changes === 1
  );
}
function prune(state: BudgetState, now: number): void {
  for (const [id, pending] of Object.entries(state.pending))
    if (pending.at + 600000 < now) delete state.pending[id];
}
export async function reserveRequests(
  connectionId: string,
  count: number,
  purpose: BudgetPurpose,
  nowISO: string,
  env: Env,
): Promise<BudgetDecision> {
  const now = Date.parse(nowISO);
  if (!Number.isSafeInteger(count) || count < 1 || count > 30 || !Number.isFinite(now))
    throw new ServiceError('BUDGET_INPUT', 'طلب الحصة غير صالح.');
  const client = await clientIdentity(connectionId, env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await rowFor(client, now, env),
      state = JSON.parse(row.state_json) as BudgetState;
    prune(state, now);
    if (state.blockedUntil > now)
      return { kind: 'deferred', retryAt: new Date(state.blockedUntil).toISOString() };
    const blockers = state.windows.filter((w) =>
      w.resetAt <= now
        ? count > 1
        : w.remaining - count < (purpose === 'receipt' ? 0 : Math.ceil(w.quota * 0.1)),
    );
    if (blockers.length || Object.keys(state.pending).length >= 256)
      return {
        kind: 'deferred',
        retryAt: new Date(Math.max(now + 1000, ...blockers.map((w) => w.resetAt))).toISOString(),
      };
    for (const window of state.windows) {
      // Rolling expiry permits one probe. Only the next live header can restore credits.
      if (window.resetAt <= now) {
        window.remaining = 0;
        window.resetAt = now + 60000;
      } else window.remaining -= count;
    }
    const reservationId = crypto.randomUUID();
    state.pending[reservationId] = { count, at: now };
    if (await save(client, row, state, env)) return { kind: 'allowed', reservationId };
  }
  return { kind: 'deferred', retryAt: new Date(now + 1000).toISOString() };
}
interface ParsedPolicy {
  policy: string;
  quota: number;
  seconds: number;
}
function fields(header: string | null): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const part of (header ?? '').split(',')) {
    const name = /^\s*"([^"]+)"/.exec(part)?.[1];
    if (!name) continue;
    const params = new Map<string, string>();
    for (const match of part.matchAll(/;\s*([a-z]+)\s*=\s*([^;\s]+)/gi))
      params.set(match[1]!, match[2]!);
    result.set(name, params);
  }
  return result;
}
export async function observeRateLimits(
  connectionId: string,
  headers: Headers,
  nowISO: string,
  env: Env,
  reservationId?: string,
): Promise<void> {
  const now = Date.parse(nowISO),
    client = await clientIdentity(connectionId, env);
  const policiesHeader = fields(headers.get('RateLimit-Policy')),
    limitsHeader = fields(headers.get('RateLimit'));
  const live: ParsedPolicy[] = [];
  for (const [policy, params] of policiesHeader) {
    const quota = Number(params.get('q')),
      seconds = Number(params.get('w'));
    if (
      Number.isSafeInteger(quota) &&
      quota > 0 &&
      Number.isSafeInteger(seconds) &&
      seconds > 0 &&
      seconds <= 2592000
    )
      live.push({ policy, quota, seconds });
  }
  const serverTime = Date.parse(headers.get('Date') ?? '');
  const observedAt = Number.isFinite(serverTime) ? Math.min(now, serverTime) : now;
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await rowFor(client, now, env),
      state = JSON.parse(row.state_json) as BudgetState;
    prune(state, now);
    if (reservationId) delete state.pending[reservationId];
    const pending = Object.values(state.pending).reduce((sum, p) => sum + p.count, 0);
    for (const policy of live) {
      const limit = limitsHeader.get(policy.policy),
        remaining = Number(limit?.get('r')),
        reset = Number(limit?.get('t'));
      if (
        !limit ||
        !Number.isSafeInteger(remaining) ||
        remaining < 0 ||
        !Number.isFinite(reset) ||
        reset < 0 ||
        reset > policy.seconds
      )
        continue;
      let window = state.windows.find((w) => w.seconds === policy.seconds);
      const trusted = Math.max(0, Math.min(policy.quota, remaining) - pending);
      if (!window) {
        window = { ...policy, remaining: trusted, resetAt: now + reset * 1000, observedAt };
        state.windows.push(window);
      } else {
        // A late reply with an older Date must never restore spent credits.
        window.remaining =
          observedAt <= window.observedAt ? Math.min(window.remaining, trusted) : trusted;
        window.policy = policy.policy;
        window.quota = policy.quota;
        window.observedAt = Math.max(window.observedAt, observedAt);
        window.resetAt =
          observedAt < window.observedAt
            ? Math.max(window.resetAt, now + reset * 1000)
            : now + reset * 1000;
      }
    }
    const retry = headers.get('Retry-After');
    if (retry) {
      const seconds = Number(retry),
        until = /^\d+(\.\d+)?$/.test(retry) ? now + seconds * 1000 : Date.parse(retry);
      if (Number.isFinite(until)) state.blockedUntil = Math.max(state.blockedUntil, until);
    }
    if (await save(client, row, state, env)) return;
  }
  throw new ServiceError('BUDGET_UNAVAILABLE', 'تعذر حفظ حصة الحساب.', 503, true);
}
export function nextReceiptAt(acceptedAt: string, attempt: number): string {
  const minutes =
    attempt === 0 ? 1 : attempt === 1 ? 5 : attempt === 2 ? 15 : 15 + (attempt - 2) * 60;
  return new Date(Date.parse(acceptedAt) + minutes * 60000).toISOString();
}
