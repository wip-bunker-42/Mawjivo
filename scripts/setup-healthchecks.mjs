import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Management credentials remain on the operator's computer. Only ping URLs enter the Worker. */
export async function setupHealthchecks(serviceId, managementKey, monitorTimeZone) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serviceId) || !managementKey)
    throw new Error('Invalid monitoring setup input.');
  new Intl.DateTimeFormat('en', { timeZone: monitorTimeZone }).format();
  const request = async (suffix, body) => {
    const response = await fetch('https://healthchecks.io/api/v3/' + suffix, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Api-Key': managementKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Healthchecks setup rejected (' + response.status + ').');
    return response.json();
  };
  const integrations = await request('channels/'),
    emails = integrations.channels.filter((channel) => channel.kind === 'email');
  const common = {
    tags: 'mawjivo ' + serviceId,
    channels: emails.map((channel) => channel.id).join(','),
    unique: ['slug'],
    methods: 'POST',
  };
  for (const kind of ['heartbeat', 'daily']) {
    const existing = await request('checks/?slug=mawjivo-' + serviceId.toLowerCase() + '-' + kind);
    if (
      existing.checks.some(
        (check) =>
          !String(check.tags ?? '')
            .split(/\s+/)
            .includes(serviceId),
      )
    )
      throw new Error('Healthchecks check is not owned by this service.');
  }
  const heartbeat = await request('checks/', {
    ...common,
    name: 'Mawjivo ' + serviceId + ' service',
    slug: 'mawjivo-' + serviceId.toLowerCase() + '-heartbeat',
    timeout: 300,
    grace: 600,
  });
  const daily = await request('checks/', {
    ...common,
    name: 'Mawjivo ' + serviceId + ' daily',
    slug: 'mawjivo-' + serviceId.toLowerCase() + '-daily',
    schedule: '0 0 * * *',
    tz: monitorTimeZone,
    grace: 900,
  });
  for (const check of [heartbeat, daily])
    if (!/^https:\/\/hc-ping\.com\/[a-f0-9-]{36}$/.test(check.ping_url))
      throw new Error('Healthchecks returned an invalid ping URL.');
  return {
    heartbeatPingUrl: heartbeat.ping_url,
    dailyPingUrl: daily.ping_url,
    heartbeatCheckId: heartbeat.uuid,
    dailyCheckId: daily.uuid,
    heartbeatPeriodSeconds: 300,
    heartbeatGraceSeconds: 600,
    dailyGraceSeconds: 900,
    monitorTimeZone,
    integrationState: emails.length ? 'email-ready' : 'needs-email',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [credentialPath, serviceId, timeZone = 'Africa/Cairo'] = process.argv.slice(2);
    if (!credentialPath || !serviceId)
      throw new Error(
        'Supply the private ENV file path and public service id; never supply the API key as an argument.',
      );
    const values = {};
    for (const line of (await readFile(credentialPath, 'utf8')).split(/\r?\n/)) {
      const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    const bindings = await setupHealthchecks(serviceId, values.HEALTHCHECKS_API_KEY, timeZone);
    const output = new URL('../.mawjivo-operator/', import.meta.url);
    await mkdir(output, { recursive: true });
    await writeFile(new URL('monitor-bindings.json', output), JSON.stringify(bindings, null, 2));
    console.log(
      'Healthchecks configured: ' +
        bindings.integrationState +
        '. Private ping bindings saved locally.',
    );
  } catch (error) {
    console.error(
      'Healthchecks setup failed. Verify the private ENV file, service id, API permissions and time zone.',
    );
    process.exitCode = 1;
  }
}
