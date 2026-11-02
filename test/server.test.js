'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { server, store } = require('../server');

let base, port;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = 'http://127.0.0.1:' + port;
});

test.after(() => { server.close(); });

/** Small http client — no fetch, so the tests run anywhere node does. */
function req(path, opts = {}) {
  const data = opts.body == null ? null
    : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  const headers = Object.assign({}, opts.headers || {});
  if (data) {
    headers['content-length'] = Buffer.byteLength(data);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: opts.method || 'GET', headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: d,
        text: () => d,
        json: () => JSON.parse(d)
      }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const form = (o) => Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

test('health answers', async () => {
  const r = await req('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json().ok, true);
});

test('a simulated call runs end to end over HTTP', async () => {
  const start = await req('/api/calls', { method: 'POST', body: { from: '+919800000001', lang: 'en' } });
  assert.equal(start.status, 201);
  const { id, say } = start.json();
  assert.ok(id && say.length >= 1);

  const turn = async (text) => {
    const r = await req('/api/calls/' + id + '/turn', { method: 'POST', body: { text } });
    assert.equal(r.status, 200);
    return r.json();
  };

  let out = await turn('is the fridge working at your end? I wanted to check about the milk.');
  assert.equal(out.call.read.scenario, 'coded');
  assert.equal(out.call.state, 'codedAck');

  await turn('One.');
  await turn('Kothrud, Pune. Near the temple.');
  await turn('Haan.');
  out = await turn('Sunita.');

  assert.equal(out.call.state, 'dispatched');
  assert.equal(out.call.entities.location, 'Kothrud, Pune');
  assert.equal(out.call.entities.name, 'Sunita');
  assert.ok(out.call.actions.length >= 3);
});

test('a human can take the line and the agent goes quiet', async () => {
  const start = await req('/api/calls', { method: 'POST', body: { from: '+919800000002' } });
  const { id } = start.json();
  const ho = await req('/api/calls/' + id + '/handover', { method: 'POST', body: { by: 'dispatcher-console' } });
  const j = ho.json();
  assert.equal(j.call.handedOver.by, 'dispatcher-console');
  assert.equal(j.call.state, 'handover');
});

test('transcript can be purged on request', async () => {
  const start = await req('/api/calls', { method: 'POST', body: { from: '+919800000003' } });
  const { id } = start.json();
  await req('/api/calls/' + id + '/turn', { method: 'POST', body: { text: 'please help me, someone is following me' } });

  const r = await req('/api/calls/' + id + '/purge', { method: 'POST' });
  assert.equal(r.status, 200);

  const after = (await req('/api/calls/' + id)).json();
  assert.equal(after.call.turns.length, 1);
  assert.match(after.call.turns[0].text, /purged/);
});

test('the Twilio webhook returns valid TwiML with a speech gather', async () => {
  const r = await req('/telephony/twilio/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ From: '+919800000004', To: '+911200', CallSid: 'CA123' })
  });
  assert.equal(r.status, 200);
  const body = r.text();
  assert.match(body, /^<\?xml/);
  assert.match(body, /<Response>/);
  assert.match(body, /<Gather input="speech dtmf"/);
  assert.match(body, /<Say language="en-IN">/);
  assert.match(body, /<\/Response>$/);
});

test('Twilio turn: speech is routed into the same state machine', async () => {
  const voice = await req('/telephony/twilio/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ From: '+919800000005' })
  });
  const callId = (voice.text().match(/callId=([A-Za-z0-9-]+)/) || [])[1];
  assert.ok(callId, 'the action URL must carry the call id');

  const turn = await req('/telephony/twilio/turn?callId=' + callId, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ SpeechResult: 'Haan, koi mujhe follow kar raha hai, please help karo', Confidence: '0.91' })
  });
  const body = turn.text();
  assert.match(body, /<Say language="en-IN">/);
  assert.match(body, /Where are you right now/);

  const session = store.get(callId);
  assert.equal(session.read.scenario, 'explicit');
});

test('keypad digits are read as one and two', async () => {
  const voice = await req('/telephony/twilio/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ From: '+919800000006' })
  });
  const callId = (voice.text().match(/callId=([A-Za-z0-9-]+)/) || [])[1];

  await req('/telephony/twilio/turn?callId=' + callId, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ SpeechResult: "I can't talk, someone is here" })
  });
  const r = await req('/telephony/twilio/turn?callId=' + callId, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ Digits: '1' })
  });
  const session = store.get(callId);
  assert.equal(session.state, 'silent');
  assert.equal(session.silentAnswers.someoneWithYou, 'yes');
  assert.match(r.text(), /<Gather/);
});
