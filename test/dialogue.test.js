'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dialogue = require('../lib/dialogue');
const { decode, extractLocation, extractName, cannotSpeak } = require('../lib/decoder');

function open() {
  const s = dialogue.createSession({ from: '+919800000000' });
  const greeting = dialogue.startCall(s);
  return { s, greeting };
}

test('scenario 1 — said plainly: explicit read, location, name, dispatch', () => {
  const { s, greeting } = open();
  assert.equal(s.state, 'greet');
  assert.ok(greeting.say.length >= 1);

  let out = dialogue.handleTurn(s, 'Haan, main bol sakti hoon. Koi mujhe follow kar raha hai, please help karo.');
  assert.equal(s.read.scenario, 'explicit');
  assert.equal(s.canSpeak, true);
  assert.equal(s.state, 'where');
  assert.equal(out.expect, 'speech');

  dialogue.handleTurn(s, 'Main Dadar station ke bahar hoon, platform 3 ke paas.');
  assert.equal(s.location, 'Dadar Station');
  assert.equal(s.state, 'confirmLoc');

  dialogue.handleTurn(s, 'Haan, sahi hai.');
  assert.equal(s.state, 'name');

  dialogue.handleTurn(s, 'Priya.');
  assert.equal(s.state, 'dispatched');
  assert.equal(s.name, 'Priya');
  assert.ok(s.actions.length >= 3);
});

test('scenario 2a — coded safe phrase: no threat word, still escalates', () => {
  const { s } = open();
  const said = 'is the fridge working at your end? I just wanted to check about the milk.';
  const d = decode(said);
  assert.equal(d.scenario, 'coded');
  assert.ok(d.score >= 0.8);
  assert.equal(d.signals.filter((x) => !x.explicit).length > 0, true);

  dialogue.handleTurn(s, said);
  assert.equal(s.state, 'codedAck', 'agent acknowledges the reading before asking anything else');

  dialogue.handleTurn(s, 'One.');
  assert.equal(s.state, 'where');

  dialogue.handleTurn(s, 'Kothrud, Pune. Near the temple.');
  assert.equal(s.location, 'Kothrud, Pune');

  dialogue.handleTurn(s, 'Haan.');
  dialogue.handleTurn(s, 'Sunita.');
  assert.equal(s.state, 'dispatched');
  assert.equal(s.name, 'Sunita');
});

test('scenario 2b — third person and confinement, decoded', () => {
  const { s } = open();
  dialogue.handleTurn(s, "Hi, this is for a friend. Suppose someone's husband locks the door from outside and takes the phone.");
  assert.equal(s.read.scenario, 'coded');
  assert.ok(s.read.codedKinds.includes('third_person'));
  assert.ok(s.read.codedKinds.includes('confinement'));

  dialogue.handleTurn(s, 'One. She can not talk. The door is locked from outside.');
  assert.equal(s.canSpeak, true, 'a description of someone else must not be read as the caller being unable to speak');

  dialogue.handleTurn(s, "It's flat 402, Sai Residency, Kalyan.");
  assert.equal(s.location, 'Flat 402, Sai Residency, Kalyan');
});

test('scenario 2c — cannot speak: one-word ladder, registered address', () => {
  const { s } = open();
  dialogue.handleTurn(s, "… I can't talk. Someone is here.");
  assert.equal(s.state, 'silent');
  assert.equal(s.canSpeak, false);

  ['One.', 'Two.', 'One.', 'One.', 'One.'].forEach((answer) => dialogue.handleTurn(s, answer));
  assert.equal(s.state, 'dispatched');
  assert.equal(s.location, s.registered.address);
  assert.equal(s.silentAnswers.someoneWithYou, 'yes');
  assert.equal(s.silentAnswers.hurt, 'no');
  assert.equal(s.silentAnswers.threatIsPerson, 'yes');
});

test('silence twice puts a human on the line', () => {
  const { s } = open();
  dialogue.handleTurn(s, '');
  assert.equal(s.needsHuman, false);
  const out = dialogue.handleTurn(s, '');
  assert.equal(out.expect, 'human');
  assert.equal(s.needsHuman, true);
});

test('a caller who declines to give a name is not pushed', () => {
  const { s } = open();
  dialogue.handleTurn(s, 'Please help, someone is following me.');
  dialogue.handleTurn(s, 'Near Andheri flyover.');
  dialogue.handleTurn(s, 'Haan.');
  dialogue.handleTurn(s, 'Haan.'); // "yes" in answer to "what is your name" = declining
  assert.equal(s.state, 'dispatched');
  assert.equal(s.name, 'not given');
  assert.equal(s.nameSrc, 'declined — not pushed');
});

test('no landmark given falls back to tower location, never invents one', () => {
  const { s } = open();
  dialogue.handleTurn(s, 'Someone is following me, help.');
  dialogue.handleTurn(s, 'I do not know where I am.');
  assert.equal(s.location, null);
  dialogue.handleTurn(s, 'I cannot see anything.');
  assert.equal(s.location, 'tower location from this phone');
  assert.equal(s.locationSrc, 'no landmark given — using cell and GPS');
});

test('handover stops the agent speaking', () => {
  const { s } = open();
  dialogue.handleTurn(s, 'Help me, he has a knife.');
  dialogue.handover(s, 'dispatcher-4');
  assert.equal(s.handedOver.by, 'dispatcher-4');
  const out = dialogue.handleTurn(s, 'what should I do');
  assert.deepEqual(out.say, []);
  assert.equal(out.expect, 'human');
});

test('entity extraction does not invent places out of ordinary sentences', () => {
  assert.equal(extractLocation('is the fridge working at your end?'), null);
  assert.equal(extractLocation('this is for a friend, suppose it happens to her'), null);
  assert.equal(extractLocation('Main Dadar station ke bahar hoon'), 'Dadar Station');
  assert.equal(extractLocation("It's flat 402, Sai Residency, Kalyan."), 'Flat 402, Sai Residency, Kalyan');
  assert.equal(extractName('One.'), null);
  assert.equal(extractName('this is for a friend'), null);
  assert.equal(extractName('You can call me R.'), 'R');
});

test('cannotSpeak ignores third-person descriptions', () => {
  assert.equal(cannotSpeak("I can't talk, someone is here"), true);
  assert.equal(cannotSpeak("she can't talk, her husband is there"), false);
});

test('an ordinary sentence is not an emergency', () => {
  const d = decode('Kohli hit a six, the stadium was so loud, what a match yaar');
  assert.equal(d.scenario, 'none');
  assert.equal(d.escalate, false);
});
