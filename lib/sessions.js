'use strict';
/**
 * sessions.js — where calls live while they are happening, and how long their
 * words are allowed to exist afterwards.
 *
 * In memory on purpose: a call is stateful for a few minutes and a database is
 * not the hard part. What IS the hard part is retention — the transcript is the
 * most sensitive thing this system holds, so every session carries a purge time
 * and the sweeper actually enforces it.
 */

const { EventEmitter } = require('events');

class CallStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.calls = new Map();
    this.retentionMinutes = Number(opts.retentionMinutes || 30);
    this.maxCalls = Number(opts.maxCalls || 500);
  }

  add(session) {
    this.calls.set(session.id, session);
    this.emit('update', session);
    // keep memory bounded even under a flood of calls
    if (this.calls.size > this.maxCalls) {
      const oldest = [...this.calls.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (oldest) this.calls.delete(oldest.id);
    }
    return session;
  }

  get(id) { return this.calls.get(id) || null; }

  list() {
    return [...this.calls.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((s) => ({
        id: s.id, from: s.from, state: s.state, startedAt: s.startedAt,
        scenario: s.read ? s.read.scenario : null,
        score: s.read ? s.read.score : null,
        needsHuman: s.needsHuman, handedOver: s.handedOver,
        location: s.location, name: s.name
      }));
  }

  touch(session) { this.emit('update', session); return session; }

  /** Erase the words. Keeps nothing but the fact that a call happened. */
  purge(id) {
    const s = this.calls.get(id);
    if (!s) return false;
    s.turns = [{ at: new Date().toISOString(), speaker: 'system', text: 'transcript purged under retention policy' }];
    s.callerText = '';
    s.purged = true;
    this.emit('update', s);
    return true;
  }

  /** Called on a timer. Ends stale calls and purges anything past its window. */
  sweep(now = Date.now()) {
    let purged = 0, ended = 0;
    for (const s of this.calls.values()) {
      const ageMin = (now - new Date(s.startedAt).getTime()) / 60000;
      if (!s.endedAt && ageMin > 60) {
        s.state = 'ended';
        s.endedAt = new Date().toISOString();
        s.turns.push({ at: s.endedAt, speaker: 'system', text: 'call timed out and was closed' });
        ended++;
      }
      if (!s.purged && ageMin > this.retentionMinutes && s.endedAt) {
        this.purge(s.id);
        purged++;
      }
    }
    return { purged, ended };
  }
}

module.exports = { CallStore };
