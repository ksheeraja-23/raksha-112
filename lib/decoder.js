'use strict';
/**
 * decoder.js — turns what the caller said into a reading the agent can act on.
 *
 * Two scenarios, and the difference is the whole product:
 *   1. explicit  — the caller says it plainly.
 *   2. coded     — the caller cannot or will not say it, and signals it indirectly.
 *
 * Nothing in here needs a network call. It is deliberately rule-based and
 * inspectable: a dispatcher must be able to see why the agent escalated, and
 * a model that cannot explain itself has no place on an emergency line.
 */

// ---------- Scenario 1: said plainly ----------
const EXPLICIT = [
  { re: /bachao|bacha\s?lo|kaapathunga|wacha|help me|help karo|madad|save me/i, w: 0.92,
    read: 'a direct appeal for help', threat: 'Physical danger' },
  { re: /follow(ing)? me|follow kar raha|peeche aa raha|maza maghe|follow panraanga/i, w: 0.86,
    read: 'being followed right now', threat: 'Stalking / being followed' },
  { re: /maar raha|adikkuraanga|hitting me|beating me|beat me up|pit raha/i, w: 0.89,
    read: 'being physically attacked', threat: 'Physical assault' },
  { re: /chaku|knife|gun|pistol|weapon|tava/i, w: 0.92,
    read: 'a weapon is present', threat: 'Weapon involved' },
  { re: /khoon|bleeding|rakto|blood/i, w: 0.83,
    read: 'bleeding', threat: 'Medical' },
  { re: /accident|skid|hit by a (bike|car|truck)|takkar/i, w: 0.80,
    read: 'a road accident', threat: 'Accident' },
  { re: /rape|balatkar|molest|chhed raha/i, w: 0.96,
    read: 'sexual violence', threat: 'Sexual violence' },
  { re: /threaten|dhamki|kill me|jaan se maar/i, w: 0.90,
    read: 'a threat to kill', threat: 'Threat to life' },
  { re: /ambulance|hospital|daktar|doctor chahiye/i, w: 0.60,
    read: 'a medical need', threat: 'Medical' },
  { re: /police|police bulao/i, w: 0.50,
    read: 'asking for the police', threat: 'Wants police' }
];

// ---------- Scenario 2: signalled, never said ----------
const CODED = [
  { re: /milk|doodh|fridge|blue bag|parcel|order|meeting|gas cylinder/i, w: 0.82, kind: 'safe_phrase',
    read: 'a household question on an emergency line — the shape of a pre-agreed safe phrase',
    threat: 'Signalled danger, unspecified' },
  { re: /for a friend|asking for a friend|suppose|hypothetical|a girl i know|someone i know|meri dost|ek ladki/i,
    w: 0.72, kind: 'third_person',
    read: 'the caller is describing herself in the third person', threat: 'Signalled danger, unspecified' },
  { re: /door.*(locked|lock|band)|(lock|locks|locked).*door|bahar se band|can.?t (go|leave)|nahi jaane de|phone (le liya|take)|takes? the phone|not allowed to go|andar band/i,
    w: 0.79, kind: 'confinement',
    read: 'she is confined and not free to leave', threat: 'Being confined' },
  { re: /husband|in.?laws|sasural|drunk again|nashe mein|wo phir se aa gaya|not himself|sharab/i,
    w: 0.74, kind: 'domestic',
    read: 'a domestic situation described as if it were ordinary', threat: 'Domestic violence' },
  { re: /can.?t talk|not free|call you later|baad mein baat|someone is here|koi hai yahan|sun raha|paas mein hai/i,
    w: 0.86, kind: 'cannot_speak',
    read: 'she cannot speak freely — someone may be within earshot', threat: 'Signalled danger, unspecified' },
  { re: /twenty minutes|same time|i.?ll be home|ghar aa rahi|behind the/i, w: 0.46, kind: 'repeat',
    read: 'time and place repeated as a locator, the way people do when they cannot say "I am here"',
    threat: 'Signalled danger, unspecified' },
  { re: /is this the police|are you the police|is this 112|yeh police hai/i, w: 0.60, kind: 'test',
    read: 'testing whether the line is real, without naming the danger', threat: 'Signalled danger, unspecified' },
  { re: /everything is fine|sab theek|no problem|nothing happened/i, w: 0.55, kind: 'cover',
    read: 'reassurance that contradicts the voice — a cover story for whoever is listening',
    threat: 'Signalled danger, unspecified' }
];

const YES = /^(yes|yeah|yep|ya|sure|ok|okay|correct|right|haan|ha|han|bilkul|sahi|one|1)\b/i;
const NO = /^(no|nope|nah|not|two|2|nahi|nahin|na)\b/i;
const ONE = /^(one|1|yes|haan|ha)\b/i;
const TWO = /^(two|2|no|nahi|nahin|na)\b/i;
const CANT_SPEAK = /can.?t talk|not free|call you later|baad mein|someone is here|koi hai|sun raha|paas mein|can.?t speak|whisper/i;
const ABOUT_SOMEONE_ELSE = /\b(she|he|they|her|his|friend|suppose)\b/i;

const STOPWORDS = new Set(('i my the this that a an and for not haan main wo please hi um one two three ' +
  'yes no sir madam hello nothing suppose koi mujhe hoon hai').split(' '));

const PLACE_ALT = 'bus stand|bus stop|station|platform|temple|mandir|market|mall|flyover|residency|' +
  'apartment|colony|nagar|park|metro|hospital|chowk|road|gate|depot|hotel|school|college|building|society';
const PLACE_RE = new RegExp(PLACE_ALT, 'i');
const CITY_RE = /\b(Mumbai|Pune|Delhi|Kalyan|Thane|Andheri|Dadar|Kothrud|Salt Lake|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata|Nagpur|Jaipur|Lucknow|Surat|Indore)\b/gi;

const titleCase = (w) => w.replace(/\b\w/g, (c) => c.toUpperCase());

function decode(text) {
  const hits = EXPLICIT.filter((s) => s.re.test(text));
  const codedHits = CODED.filter((s) => s.re.test(text));

  let explicitScore = hits.length ? Math.max(...hits.map((h) => h.w)) : 0;
  if (hits.length > 1) explicitScore = Math.min(1, explicitScore + 0.02 * (hits.length - 1));
  let codedScore = codedHits.length ? Math.max(...codedHits.map((h) => h.w)) : 0;
  if (codedHits.length > 1) codedScore = Math.min(1, codedScore + 0.03 * (codedHits.length - 1));

  let scenario = 'none';
  let score = 0;
  let meaning = 'Nothing here crosses the threshold yet. The agent keeps asking and does not dispatch on a guess.';

  if (explicitScore >= 0.5) {
    scenario = 'explicit';
    score = explicitScore;
    meaning = 'Said plainly: ' + hits.map((h) => h.read).slice(0, 2).join(', ') + '.';
    if (codedHits.length) meaning += ' Indirect signals are present too (' + codedHits[0].read + ').';
  } else if (codedScore >= 0.5) {
    scenario = 'coded';
    score = codedScore;
    meaning = 'Not said plainly. Signals read: ' + codedHits.map((h) => h.read).slice(0, 2).join('; ') +
      '. On a normal call this reads as nothing. On this line it reads as: she is in danger and cannot say so.';
  }

  const threat = hits.length ? hits[0].threat : (codedHits.length ? codedHits[0].threat : null);

  return {
    scenario,
    score: Math.round(score * 100) / 100,
    meaning,
    threat,
    signals: hits.map((h) => ({ n: h.read, w: h.w, explicit: true }))
      .concat(codedHits.map((h) => ({ n: h.read, w: h.w, explicit: false }))),
    codedKinds: codedHits.map((h) => h.kind),
    escalate: score >= 0.5
  };
}

function extractLocation(text) {
  // 1. a house number with its building: "flat 402, Sai Residency, Kalyan"
  const m2 = text.match(/\b(flat|house|plot|room|building)\s*(?:no\.?\s*)?([0-9]{1,4}[a-z]?)((?:\s*,?\s*[A-Z][A-Za-z]{2,})*)/i);
  if (m2) {
    const tail = (m2[3] || '').replace(/\s+/g, ' ').replace(/^[,\s]+/, '').trim();
    return titleCase(m2[1]) + ' ' + m2[2] + (tail ? ', ' + tail : '');
  }
  // 2. a name attached to a landmark: "Dadar station", "Sai Residency"
  const m1 = text.match(new RegExp('\\b([A-Za-z]{2,})\\s+(' + PLACE_ALT + ')\\b', 'i'));
  if (m1 && /^[A-Z]/.test(m1[1]) && !STOPWORDS.has(m1[1].toLowerCase())) {
    return m1[1] + ' ' + titleCase(m1[2]);
  }
  // 3. a city or well-known area
  const cities = text.match(CITY_RE);
  if (cities) return titleCase(cities.slice(0, 2).join(', '));
  // 4. a landmark on its own
  const lone = text.match(PLACE_RE);
  if (lone) return 'near the ' + lone[1].toLowerCase();
  // 5. a prepositional phrase, only if it contains something locatable
  const pre = text.match(/\b(?:near|at|in|outside|behind|opposite|ke paas|ke bahar)\s+([A-Za-z0-9][\w\s,.-]{2,40})/i);
  if (pre && (PLACE_RE.test(pre[1]) || pre[1].match(CITY_RE))) {
    return titleCase(pre[1].trim().replace(/[.,]$/, ''));
  }
  return null;
}

function extractName(text) {
  const a = text.match(/(?:my name is|mera naam|naam)\s+([A-Za-z\u0900-\u097F]{2,20})/i);
  if (a && !STOPWORDS.has(a[1].toLowerCase())) return a[1];
  const b = text.match(/(?:i am|i'm|this is|call me)\s+([A-Z](?:[a-z]{1,18})?)/);
  if (b && !STOPWORDS.has(b[1].toLowerCase())) return b[1];
  const single = text.trim().match(/^([A-Z][a-z]{1,18})[.!]?$/);
  if (single && !STOPWORDS.has(single[1].toLowerCase())) return single[1];
  return null;
}

/** Does this turn mean the caller cannot speak freely? */
function cannotSpeak(text) {
  return CANT_SPEAK.test(text) && !ABOUT_SOMEONE_ELSE.test(text);
}

module.exports = {
  decode, extractLocation, extractName, cannotSpeak,
  YES, NO, ONE, TWO, EXPLICIT, CODED
};
