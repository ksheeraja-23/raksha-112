'use strict';
/**
 * telephony.js — the bit that makes this a phone number and not a web page.
 *
 * We speak TwiML, which is just XML, so a real Twilio number works with zero
 * dependencies: the caller dials, Twilio POSTs to us, we answer with <Say> and
 * <Gather input="speech">, Twilio posts the transcript of what it heard, we
 * decide the next line. No media streaming, no websocket, nothing to install.
 *
 * Exotel, Plivo and Ozonetel all expose the same shape — a URL that returns a
 * call-flow document and a callback with the recognised text — so the adapter
 * for those is a mapping, not a rewrite. See README.
 */

const LANG_CODE = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-IN', or: 'or-IN', as: 'as-IN'
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const lang = (session) => LANG_CODE[session.lang] || 'en-IN';

/**
 * One response = the agent's lines, then a prompt waiting for the caller.
 * If the caller says nothing, Twilio re-posts to the same action URL with an
 * empty SpeechResult, which the dialogue treats as silence and reprompts.
 */
function twiml({ session, say, expect, actionUrl, dispatcherNumber }) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];

  for (const line of say || []) {
    parts.push(`  <Say language="${lang(session)}">${esc(line[session.lang] || line.en)}</Say>`);
  }

  if (expect === 'human') {
    if (dispatcherNumber) {
      parts.push(`  <Dial timeout="45">${esc(dispatcherNumber)}</Dial>`);
    } else {
      parts.push(`  <Say language="${lang(session)}">${esc('A dispatcher will call you back immediately.')}</Say>`);
      parts.push('  <Hangup/>');
    }
    parts.push('</Response>');
    return parts.join('\n');
  }

  if (expect === 'end') {
    parts.push('  <Hangup/>');
    parts.push('</Response>');
    return parts.join('\n');
  }

  // A prompt that is also the fallback text: Twilio reads the nested <Say>,
  // then listens. Silence loops back to the same URL.
  parts.push(`  <Gather input="speech dtmf" language="${lang(session)}" numDigits="1"` +
    ' speechTimeout="auto" timeout="6" actionOnEmptyResult="true"' +
    ` action="${esc(actionUrl)}" method="POST">`);
  for (const line of say || []) {
    parts.push(`    <Say language="${lang(session)}">${esc(line[session.lang] || line.en)}</Say>`);
  }
  parts.push('  </Gather>');
  parts.push(`  <Redirect method="POST">${esc(actionUrl)}</Redirect>`);
  parts.push('</Response>');
  return parts.join('\n');
}

/** Twilio posts SpeechResult for speech and Digits for keypad. Accept either. */
function readInput(body) {
  const speech = (body.SpeechResult || '').trim();
  const digits = (body.Digits || '').trim();
  if (digits === '1') return 'one';
  if (digits === '2') return 'two';
  return speech;
}

/** Exotel / Plivo style callback: the recognised text usually arrives in one field. */
function readGenericInput(body) {
  return (body.Speech || body.speech || body.transcript || body.SpeechResult || '').trim();
}

module.exports = { twiml, readInput, readGenericInput, LANG_CODE, esc };
