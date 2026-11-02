'use strict';
/**
 * server.js — the service. Zero dependencies: `node server.js` and it runs.
 *
 *   http://localhost:8080            dispatcher console (live calls, take over)
 *   POST /api/calls                  start a call (simulator / your own app)
 *   POST /api/calls/:id/turn         the caller says something
 *   POST /api/calls/:id/handover     a human takes the line
 *   POST /telephony/twilio/voice     the number Twilio dials when a call arrives
 *   POST /telephony/twilio/turn      what Twilio posts back after it listens
 *   GET  /events                     server-sent events for the console
 *   GET  /health
 *
 * Nothing here trusts the browser: the dialogue lives on the server, so the
 * same state machine serves the console, a Twilio number and a mobile app.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dialogue = require('./lib/dialogue');
const { CallStore } = require('./lib/sessions');
const telephony = require('./lib/telephony');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.DISPATCHER_TOKEN || '';
const DISPATCHER_NUMBER = process.env.DISPATCHER_NUMBER || '';
const RETENTION_MINUTES = Number(process.env.RETENTION_MINUTES || 30);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const store = new CallStore({ retentionMinutes: RETENTION_MINUTES });
const sseClients = new Set();

store.on('update', (session) => {
  const payload = JSON.stringify({ type: 'call', call: dialogue.view(session) });
  for (const res of sseClients) {
    try { res.write('data: ' + payload + '\n\n'); } catch (e) { sseClients.delete(res); }
  }
});

/* ------------------------------- helpers -------------------------------- */

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store'
  });
  res.end(s);
};

const xml = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(data || '{}')); } catch (e) { return resolve({}); }
      }
      const out = {};
      for (const [k, v] of new URLSearchParams(data)) out[k] = v;
      resolve(out);
    });
  });
}

function authorised(req) {
  if (!TOKEN) return true;
  return req.headers['x-dispatcher-token'] === TOKEN;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

function newSession(opts) {
  const s = dialogue.createSession(opts);
  store.add(s);
  const greeting = dialogue.startCall(s);
  store.touch(s);
  log('call:open', s.id, s.from, 'provider=' + s.provider);
  return { session: s, greeting };
}

function applyTurn(session, text) {
  const out = dialogue.handleTurn(session, text);
  store.touch(session);
  if (session.state === 'dispatched') log('call:dispatch', session.id, '→', session.location || 'unknown');
  if (out.needsHuman) log('call:needs-human', session.id);
  return out;
}

/* -------------------------------- server -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    // --- static console ---
    if (method === 'GET' && (p === '/' || p === '/console' || p === '/index.html')) {
      const file = path.join(__dirname, 'public', 'console.html');
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      return res.end(html);
    }

    if (method === 'GET' && p === '/health') {
      return json(res, 200, { ok: true, calls: store.calls.size, retentionMinutes: RETENTION_MINUTES });
    }

    // --- live feed for the console ---
    if (method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', calls: store.list() }) + '\n\n');
      sseClients.add(res);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
      return;
    }

    // --- telephony: inbound call ---
    if (method === 'POST' && (p === '/telephony/twilio/voice' || p === '/telephony/generic/voice')) {
      const body = await readBody(req);
      const { session, greeting } = newSession({
        from: body.From || body.from || body.caller || 'unknown',
        provider: p.includes('twilio') ? 'twilio' : 'generic',
        lang: url.searchParams.get('lang') || 'en'
      });
      const actionUrl = `${PUBLIC_URL}/telephony/${p.includes('twilio') ? 'twilio' : 'generic'}/turn?callId=${session.id}`;
      return xml(res, telephony.twiml({ session, say: greeting.say, expect: greeting.expect, actionUrl, dispatcherNumber: DISPATCHER_NUMBER }));
    }

    // --- telephony: what the caller said ---
    if (method === 'POST' && (p === '/telephony/twilio/turn' || p === '/telephony/generic/turn')) {
      const body = await readBody(req);
      const callId = url.searchParams.get('callId') || body.callId;
      const session = store.get(callId);
      if (!session) {
        return xml(res, '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call has ended.</Say><Hangup/></Response>');
      }
      const text = p.includes('twilio') ? telephony.readInput(body) : telephony.readGenericInput(body);
      const out = session.handedOver ? { say: [], expect: 'human' } : applyTurn(session, text);
      const actionUrl = `${PUBLIC_URL}/telephony/${p.includes('twilio') ? 'twilio' : 'generic'}/turn?callId=${session.id}`;
      return xml(res, telephony.twiml({ session, say: out.say, expect: out.expect, actionUrl, dispatcherNumber: DISPATCHER_NUMBER }));
    }

    // --- API (dispatcher console and the simulator) ---
    if (p.startsWith('/api/') && !authorised(req)) {
      return json(res, 401, { error: 'dispatcher token required' });
    }

    if (method === 'GET' && p === '/api/calls') {
      return json(res, 200, { calls: store.list() });
    }

    if (method === 'POST' && p === '/api/calls') {
      const body = await readBody(req);
      const { session, greeting } = newSession({
        from: body.from || '+91-unknown',
        provider: 'simulator',
        lang: body.lang === 'hi' ? 'hi' : 'en',
        consent: body.consent !== false
      });
      return json(res, 201, { id: session.id, say: greeting.say, expect: greeting.expect, call: dialogue.view(session) });
    }

    const m = p.match(/^\/api\/calls\/([^/]+)(?:\/(turn|handover|end|purge))?$/);
    if (m) {
      const session = store.get(decodeURIComponent(m[1]));
      if (!session) return json(res, 404, { error: 'no such call' });
      const action = m[2] || '';

      if (method === 'GET' && !action) return json(res, 200, { call: dialogue.view(session) });

      if (method === 'POST' && action === 'turn') {
        const body = await readBody(req);
        const out = applyTurn(session, body.text);
        return json(res, 200, {
          say: out.say, expect: out.expect, needsHuman: !!out.needsHuman,
          call: dialogue.view(session)
        });
      }

      if (method === 'POST' && action === 'handover') {
        const body = await readBody(req);
        dialogue.handover(session, body.by);
        store.touch(session);
        log('call:handover', session.id, 'by', body.by || 'dispatcher');
        return json(res, 200, { call: dialogue.view(session) });
      }

      if (method === 'POST' && action === 'end') {
        dialogue.endCall(session);
        store.touch(session);
        log('call:end', session.id);
        return json(res, 200, { call: dialogue.view(session) });
      }

      if (method === 'POST' && action === 'purge') {
        store.purge(session.id);
        log('call:purge', session.id);
        return json(res, 200, { purged: true });
      }

      return json(res, 405, { error: 'unsupported' });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    log('error', err && err.message);
    if (!res.headersSent) return json(res, 500, { error: 'internal error' });
    try { res.end(); } catch (e) {}
  }
});

// Retention sweeper. Runs whether or not anyone is watching.
const sweeper = setInterval(() => {
  const r = store.sweep();
  if (r.purged || r.ended) log('sweep', `purged=${r.purged} ended=${r.ended}`);
}, 60 * 1000);
sweeper.unref();   // do not hold the process open in tests or after a clean shutdown

if (require.main === module) {
  server.listen(PORT, () => {
    log('raksha-line listening on', PUBLIC_URL);
    log('console →', PUBLIC_URL + '/');
    log('retention', RETENTION_MINUTES + ' min', TOKEN ? '| dispatcher token required' : '| NO TOKEN SET — do not expose this publicly');
  });
}

module.exports = { server, store, sweeper };
