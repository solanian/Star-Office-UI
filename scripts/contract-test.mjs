#!/usr/bin/env node

const base = process.env.CONTRACT_BASE_URL || 'http://127.0.0.1:19000';

let cookie = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function req(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(base + path, { ...options, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep text body.
  }
  return { res, body, text };
}

async function main() {
  console.log(`[contract] base=${base}`);

  for (const path of ['/', '/electron-standalone', '/join', '/invite']) {
    const { res, text } = await req(path);
    assert(res.status === 200, `${path} expected 200 got ${res.status}`);
    assert(text.includes('<!DOCTYPE html') || text.includes('<html'), `${path} did not return HTML`);
    console.log(`  OK page ${path}`);
  }

  {
    const { res, body } = await req('/health');
    assert(res.status === 200, '/health status');
    assert(body.status === 'ok' && body.service === 'star-office-ui', '/health body');
    console.log('  OK health');
  }

  {
    const { res, body } = await req('/status');
    assert(res.status === 200, '/status status');
    assert(body.state, '/status state');
    const set = await req('/set_state', { method: 'POST', json: { state: 'writing', detail: 'contract writing' } });
    assert(set.res.status === 200 && set.body.status === 'ok', '/set_state write');
    const after = await req('/status');
    assert(after.body.state === 'writing' && after.body.detail === 'contract writing', '/status after write');
    await req('/set_state', { method: 'POST', json: { state: 'idle', detail: 'contract idle' } });
    console.log('  OK status/set_state');
  }

  {
    const agents = await req('/agents');
    assert(agents.res.status === 200 && Array.isArray(agents.body), '/agents list');
    assert(agents.body.some((a) => a.agentId === 'star' && a.isMain), '/agents main star');

    const badJoin = await req('/join-agent', { method: 'POST', json: { name: 'bad' } });
    assert(badJoin.res.status === 400, '/join-agent missing key');

    const join = await req('/join-agent', {
      method: 'POST',
      json: { name: 'Contract Agent', joinKey: 'ocj_example_team_01', state: 'working', detail: 'joined' }
    });
    assert(join.res.status === 200 && join.body.ok && join.body.agentId, '/join-agent valid');
    const agentId = join.body.agentId;

    const push = await req('/agent-push', {
      method: 'POST',
      json: { agentId, joinKey: 'ocj_example_team_01', state: 'running', detail: 'executing', name: 'Contract Agent' }
    });
    assert(push.res.status === 200 && push.body.ok && push.body.area === 'writing', '/agent-push valid');

    const leave = await req('/leave-agent', { method: 'POST', json: { agentId } });
    assert(leave.res.status === 200 && leave.body.ok, '/leave-agent');
    console.log('  OK agent lifecycle');
  }

  {
    const unauth = await req('/assets/positions');
    assert(unauth.res.status === 401, '/assets/positions unauth');

    const auth = await req('/assets/auth', { method: 'POST', json: { password: '1234' } });
    assert(auth.res.status === 200 && auth.body.ok, '/assets/auth');
    const status = await req('/assets/auth/status');
    assert(status.body.authed === true, '/assets/auth/status');

    const pos = await req('/assets/positions', { method: 'POST', json: { key: 'contract.asset', x: 1, y: 2, scale: 1.5 } });
    assert(pos.res.status === 200 && pos.body.ok, '/assets/positions post');
    const posGet = await req('/assets/positions');
    assert(posGet.body.items['contract.asset'].x === 1, '/assets/positions get');
    console.log('  OK asset auth/positions');
  }

  {
    const list = await req('/assets/list');
    assert(list.res.status === 200 && list.body.ok && list.body.count > 0, '/assets/list');

    const gemini = await req('/config/gemini');
    assert(gemini.res.status === 200 && gemini.body.ok, '/config/gemini get');

    const gen = await req('/assets/generate-rpg-background', { method: 'POST', json: {} });
    assert(gen.res.status === 400 && gen.body.code === 'MISSING_API_KEY', '/assets/generate-rpg-background missing key');

    const poll = await req('/assets/generate-rpg-background/poll?task_id=missing');
    assert(poll.res.status === 404, '/assets/generate-rpg-background/poll missing');
    console.log('  OK assets/gemini preflight');
  }

  console.log('\n[contract] PASS');
}

main().catch((err) => {
  console.error('\n[contract] FAIL');
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
