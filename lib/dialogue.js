'use strict';
/**
 * dialogue.js — the call itself.
 *
 * A plain state machine over a session object. No framework, no I/O, no timers:
 * give it the caller's words, it gives you the agent's next line and what it
 * expects back. That keeps it testable, and it means the same code runs behind
 * a Twilio number, an Exotel flow, or the local simulator.
 *
 *   greet → (cannot speak?) → silent ladder → dispatch
 *         → (explicit?)     → where → confirm → name → dispatch
 *         → (coded?)        → acknowledge → where → confirm → name → dispatch
 *         → (unclear)       → ask again → … → human handover
 */

const { decode, extractLocation, extractName, cannotSpeak, YES, NO, ONE, TWO } = require('./decoder');

// Every line exists in both languages; the agent speaks the caller's.
const L = {
  greet: {
    en: 'This is the Raksha emergency line. Are you able to speak safely? Say yes, or say no.',
    hi: 'यह रक्षा आपातकालीन लाइन है। क्या आप सुरक्षित रूप से बोल सकती हैं? हाँ कहिए, या ना कहिए।'
  },
  what: {
    en: 'Tell me what is happening. Take your time.',
    hi: 'बताइए क्या हो रहा है। आराम से बोलिए।'
  },
  whatAgain: {
    en: 'I did not catch that. Tell me in one sentence what is happening.',
    hi: 'मैं समझ नहीं पाई। एक वाक्य में बताइए क्या हो रहा है।'
  },
  codedAck: {
    en: 'I understand you. I am treating that as a signal that you are in danger, even though you did not say it. If you cannot say it out loud, say one for yes and two for no.',
    hi: 'मैं समझ गई। आपने सीधे नहीं कहा, फिर भी मैं इसे खतरे का संकेत मान रही हूँ। अगर ज़ोर से नहीं बोल सकतीं, तो हाँ के लिए एक और ना के लिए दो कहिए।'
  },
  where: {
    en: 'Where are you right now? The area, or a landmark near you.',
    hi: 'आप अभी कहाँ हैं? इलाके का नाम, या पास की कोई जगह बताइए।'
  },
  whereRepair: {
    en: 'Is there a shop, temple, bus stop or a signboard you can see? Say the first thing you see.',
    hi: 'कोई दुकान, मंदिर, बस स्टॉप या बोर्ड दिख रहा है? जो पहले दिखे, वह बताइए।'
  },
  confirm: {
    en: 'I have you at {loc}. Is that right? Say yes or no.',
    hi: 'मैंने आपकी जगह {loc} दर्ज की है। सही है? हाँ या ना कहिए।'
  },
  name: {
    en: 'What is your name? First name is enough, and you do not have to tell me if you would rather not.',
    hi: 'आपका नाम क्या है? पहला नाम काफी है, और न बताना चाहें तो न बताइए।'
  },
  dispatch: {
    en: 'Help is being sent to {loc}. {name}, stay on the line with me. I am also calling your family contact and sending her your location.',
    hi: '{loc} पर मदद भेजी जा रही है। {name}, मेरे साथ लाइन पर बनी रहिए। मैं आपके परिवार के संपर्क को भी फोन कर रही हूँ और आपकी जगह भेज रही हूँ।'
  },
  silentMode: {
    en: 'Do not speak if it is not safe. Say one for yes and two for no. Is someone with you right now?',
    hi: 'अगर सुरक्षित नहीं है तो मत बोलिए। हाँ के लिए एक, ना के लिए दो। क्या अभी कोई आपके साथ है?'
  },
  silentHurt: { en: 'Are you hurt?', hi: 'क्या आपको चोट लगी है?' },
  silentHome: { en: 'Are you at home?', hi: 'क्या आप घर पर हैं?' },
  silentAddr: {
    en: 'I have your registered address — {addr}. Is that where you are? One for yes, two for no.',
    hi: 'मेरे पास आपका दर्ज पता है — {addr}। क्या आप वहीं हैं? हाँ के लिए एक, ना के लिए दो।'
  },
  silentThreat: {
    en: 'Is the person with you the one who is hurting you? One for yes, two for no.',
    hi: 'क्या साथ वाला ही व्यक्ति आपको नुकसान पहुँचा रहा है? हाँ के लिए एक, ना के लिए दो।'
  },
  silentDispatch: {
    en: 'Help is being sent to {addr}. I will not say anything you have not said. Keep the line open, and stay quiet if you need to. A human dispatcher is being alerted now.',
    hi: '{addr} पर मदद भेजी जा रही है। आपने जो नहीं कहा, मैं वह नहीं कहूँगी। लाइन खुली रखिए, ज़रूरत हो तो चुप रहिए। अभी एक डिस्पैचर को सूचित किया जा रहा है।'
  },
  noSpeech: {
    en: 'I cannot hear you. If you can hear me, say one for yes.',
    hi: 'मुझे आपकी आवाज़ नहीं आ रही। अगर सुनाई दे रहा है तो एक कहिए।'
  },
  handover: {
    en: 'I am connecting you to a person now. Please stay on the line.',
    hi: 'मैं आपको एक व्यक्ति से जोड़ रही हूँ। कृपया लाइन पर बनी रहिए।'
  },
  hold: {
    en: 'I am still here. Help is on the way. Tell me if anything changes.',
    hi: 'मैं अभी भी यहाँ हूँ। मदद आ रही है। कुछ बदले तो बताइए।'
  },
  consent: {
    en: 'This call may be recorded and shared with emergency responders.',
    hi: 'यह कॉल रिकॉर्ड हो सकती है और आपातकालीन सहायता टीम के साथ साझा की जा सकती है।'
  }
};

const SILENT_STEPS = [
  { q: 'silentMode', key: 'someoneWithYou' },
  { q: 'silentHurt', key: 'hurt' },
  { q: 'silentHome', key: 'atHome' },
  { q: 'silentAddr', key: 'addressOk', addr: true },
  { q: 'silentThreat', key: 'threatIsPerson' }
];

const fill = (line, vars) => {
  const out = {};
  for (const k of Object.keys(line)) {
    let s = line[k];
    for (const v of Object.keys(vars || {})) s = s.split('{' + v + '}').join(vars[v]);
    out[k] = s;
  }
  return out;
};

let counter = 0;
function createSession(opts = {}) {
  counter += 1;
  return {
    id: opts.id || 'RK-' + Date.now().toString(36).toUpperCase() + '-' + counter,
    from: opts.from || 'unknown',
    provider: opts.provider || 'simulator',
    lang: opts.lang === 'hi' ? 'hi' : 'en',
    state: 'new',
    consent: opts.consent !== false,
    startedAt: new Date().toISOString(),
    endedAt: null,
    turns: [],
    callerText: '',
    name: null, nameSrc: null,
    location: null, locationSrc: null,
    canSpeak: null,
    read: null,
    actions: [],
    silentStep: 0,
    silentAnswers: {},
    reprompts: 0,
    needsHuman: false,
    handedOver: null,
    registered: opts.registered || { address: 'Flat 12, Green Park, New Delhi', contact: 'Meera (sister)' }
  };
}

const say = (line, vars) => fill(line, vars);

function log(session, speaker, text, extra) {
  session.turns.push(Object.assign({ at: new Date().toISOString(), speaker, text }, extra || {}));
}

function startCall(session) {
  session.state = 'greet';
  const lines = [];
  if (session.consent) lines.push(say(L.consent));
  lines.push(say(L.greet));
  lines.forEach((l) => log(session, 'agent', l[session.lang] || l.en));
  return { say: lines, expect: 'speech' };
}

/** The agent's next move, given what the caller just said (empty string = silence). */
function handleTurn(session, rawText) {
  const text = String(rawText || '').trim();

  if (session.state === 'ended') return { say: [], expect: 'end', done: true };
  if (session.handedOver) return { say: [], expect: 'human' };

  // Nothing heard: ask once more, then put a human on the line.
  if (!text) {
    session.reprompts += 1;
    if (session.reprompts >= 2) {
      session.needsHuman = true;
      session.state = 'handover';
      log(session, 'system', 'no speech twice — handing to a human dispatcher');
      log(session, 'agent', L.handover[session.lang]);
      return { say: [say(L.handover)], expect: 'human', needsHuman: true };
    }
    log(session, 'agent', L.noSpeech[session.lang]);
    return { say: [say(L.noSpeech)], expect: 'speech' };
  }
  session.reprompts = 0;
  log(session, 'caller', text);

  session.callerText = (session.callerText + ' ' + text).trim();
  session.read = decode(session.callerText);

  const loc = extractLocation(text);
  if (loc && !session.location) {
    session.location = loc;
    session.locationSrc = 'said on the call';
  }
  const nm = extractName(text);
  if (nm && !session.name && session.state === 'name') {
    session.name = nm;
    session.nameSrc = 'said on the call';
  }

  if (cannotSpeak(text) && session.canSpeak !== false && session.state !== 'silent') {
    session.canSpeak = false;
    return enterSilent(session);
  }

  return advance(session, text);
}

function reply(session, line, vars, expect) {
  const l = say(line, vars);
  log(session, 'agent', l[session.lang] || l.en);
  return { say: [l], expect: expect || 'speech' };
}

function advance(session, text) {
  const yes = YES.test(text);
  const no = NO.test(text);

  switch (session.state) {
    case 'greet': {
      session.canSpeak = no ? false : true;
      if (no) return enterSilent(session);
      const r = session.read;
      if (r && r.scenario === 'explicit') { session.state = 'where'; return reply(session, L.where); }
      if (r && r.scenario === 'coded') { session.state = 'codedAck'; return reply(session, L.codedAck); }
      session.state = 'what';
      return reply(session, L.what);
    }

    case 'what': {
      const r = session.read;
      if (r && r.scenario === 'explicit') { session.state = 'where'; return reply(session, L.where); }
      if (r && r.scenario === 'coded') { session.state = 'codedAck'; return reply(session, L.codedAck); }
      session.state = 'what2';
      return reply(session, L.whatAgain);
    }

    case 'what2':
      session.state = 'where';
      return reply(session, L.where);

    case 'codedAck':
      session.state = 'where';
      return reply(session, L.where);

    case 'where':
      if (session.location) {
        session.state = 'confirmLoc';
        return reply(session, L.confirm, { loc: session.location });
      }
      session.state = 'whereRepair';
      return reply(session, L.whereRepair);

    case 'whereRepair':
      if (session.location) {
        session.state = 'confirmLoc';
        return reply(session, L.confirm, { loc: session.location });
      }
      session.location = 'tower location from this phone';
      session.locationSrc = 'no landmark given — using cell and GPS';
      session.state = 'confirmLoc';
      return reply(session, L.confirm, { loc: session.location });

    case 'confirmLoc':
      if (no) {
        session.location = null;
        session.locationSrc = null;
        session.state = 'whereRepair';
        return reply(session, L.whereRepair);
      }
      session.state = 'name';
      return reply(session, L.name);

    case 'name': {
      if (!session.name) {
        session.name = yes ? 'not given' : (extractName(text) || 'not given');
        session.nameSrc = yes ? 'declined — not pushed' : 'said on the call';
      }
      return dispatch(session);
    }

    case 'silent':
      return silentAdvance(session, text);

    case 'dispatched':
      return reply(session, L.hold);

    default:
      session.state = 'what';
      return reply(session, L.what);
  }
}

function enterSilent(session) {
  session.silent = true;
  session.canSpeak = false;
  session.state = 'silent';
  session.silentStep = 0;
  log(session, 'system', 'caller cannot speak freely — one-word mode, agent will not repeat her words aloud');
  return reply(session, L.silentMode);
}

function silentAdvance(session, text) {
  const step = SILENT_STEPS[session.silentStep];
  if (!step) return dispatch(session);
  const one = ONE.test(text);
  const two = TWO.test(text);
  session.silentAnswers[step.key] = one ? 'yes' : (two ? 'no' : 'unclear');
  session.silentStep += 1;

  const next = SILENT_STEPS[session.silentStep];
  if (!next) return dispatch(session);
  if (next.addr) return reply(session, L.silentAddr, { addr: session.registered.address });
  return reply(session, L[next.q]);
}

function dispatch(session) {
  session.state = 'dispatched';
  session.dispatchedAt = new Date().toISOString();

  if (session.silent) {
    session.location = session.location || session.registered.address;
    session.locationSrc = session.locationSrc || 'registered address, confirmed by one-word answers';
    session.name = session.name || 'registered caller';
    session.actions = [
      'dispatch unit to ' + session.location,
      'alert ' + session.registered.contact + ' by push, SMS and voice call',
      'line held open, agent silent unless the caller speaks'
    ];
    return reply(session, L.silentDispatch, { addr: session.location });
  }

  session.actions = [
    'dispatch to ' + (session.location || 'tower location'),
    'call family contact ' + session.registered.contact + ' with the decoded read',
    'send location link by SMS',
    'keep the agent on the line until a human takes over'
  ];
  return reply(session, L.dispatch, { loc: session.location || 'your location', name: session.name || '' });
}

/** A human dispatcher takes the line. The agent stops speaking from here. */
function handover(session, by) {
  session.handedOver = { by: by || 'dispatcher', at: new Date().toISOString() };
  session.state = 'handover';
  log(session, 'system', 'taken over by ' + session.handedOver.by);
  return { say: [], expect: 'human' };
}

function endCall(session) {
  session.state = 'ended';
  session.endedAt = new Date().toISOString();
  log(session, 'system', 'call ended');
  return { say: [], expect: 'end', done: true };
}

/** Public view of a session — safe to send to the dispatcher console. */
function view(session) {
  return {
    id: session.id,
    from: session.from,
    provider: session.provider,
    lang: session.lang,
    state: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    turns: session.turns,
    read: session.read,
    entities: {
      name: session.name, nameSrc: session.nameSrc,
      location: session.location, locationSrc: session.locationSrc,
      canSpeak: session.canSpeak
    },
    silentAnswers: session.silentAnswers,
    actions: session.actions,
    needsHuman: session.needsHuman,
    handedOver: session.handedOver
  };
}

module.exports = { createSession, startCall, handleTurn, handover, endCall, view, L };
