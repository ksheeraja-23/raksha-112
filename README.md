# Raksha Line

An inbound emergency call service for India. Someone dials one number, an agent
answers, works out what they mean — **including when they can't say it** — asks
for a location and a name, and puts help on the road. A human dispatcher can
take the line at any moment.

This is the deployable version of the prototype: the dialogue lives on the
server, so the same state machine serves a real phone number, the dispatcher
console and any app you point at it.

```
caller ──dials──▶ telephony provider ──HTTP──▶ this service ──▶ dialogue state machine
                                                   │                    │
                                                   ├──▶ dispatcher console (live)
                                                   └──▶ family alert + dispatch actions
```

## Run it

Requires Node 18+. No dependencies, nothing to install.

```bash
node server.js
# → http://localhost:8080   dispatcher console
```

```bash
node --test test/          # 18 tests: all four scenarios, TwiML, purge, handover
```

Environment (all optional, see `.env.example`):

| var | default | what it does |
|---|---|---|
| `PORT` | 8080 | http port |
| `PUBLIC_URL` | `http://localhost:PORT` | base URL used in TwiML callback URLs — **set this in production** |
| `DISPATCHER_TOKEN` | *(none)* | if set, `/api/*` requires `x-dispatcher-token` |
| `DISPATCHER_NUMBER` | *(none)* | number to `<Dial>` when a call is handed to a human |
| `RETENTION_MINUTES` | 30 | transcripts are erased this long after a call ends |

## The four calls this handles

Try each one from the console's **Simulate a caller** panel, or with curl:

```bash
ID=$(curl -s -XPOST localhost:8080/api/calls -H 'content-type: application/json' \
     -d '{"from":"+919800000000"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -XPOST localhost:8080/api/calls/$ID/turn -H 'content-type: application/json' \
  -d '{"text":"is the fridge working at your end? I wanted to check about the milk."}'
```

1. **Says it plainly** — "koi mujhe follow kar raha hai, please help karo" → explicit read → where → confirm → name → dispatch.
2. **Talks in code** — "is the fridge working at your end?" contains no threat word. The agent scores it, **says out loud that it is treating it as a signal**, then switches her to one-for-yes / two-for-no.
3. **Talks in code, third person** — "suppose someone's husband locks the door from outside" → third-person displacement + confinement.
4. **Cannot speak at all** — "I can't talk, someone is here" → one-word ladder, registered address, agent stops repeating her words.

## Wiring a real phone number (Twilio)

1. Buy an Indian number with voice (or a local number for testing).
2. Set the number's **A call comes in** webhook to `POST {PUBLIC_URL}/telephony/twilio/voice`.
3. Set `PUBLIC_URL` and `DISPATCHER_NUMBER`, start the service behind TLS.
4. Call it.

The webhook returns TwiML:

```xml
<Response>
  <Gather input="speech dtmf" language="en-IN" numDigits="1"
          speechTimeout="auto" timeout="6" actionOnEmptyResult="true"
          action="https://…/telephony/twilio/turn?callId=RK-…" method="POST">
    <Say language="en-IN">This is the Raksha emergency line…</Say>
  </Gather>
  <Redirect method="POST">https://…/telephony/twilio/turn?callId=RK-…</Redirect>
</Response>
```

Twilio posts `SpeechResult` (and `Digits` if the caller presses 1 or 2), which
goes straight into the same state machine. Silence re-posts to the same URL,
which the dialogue treats as a reprompt — twice, then a human.

**Other providers.** Exotel, Plivo and Ozonetel expose the same shape: a URL
that returns a call-flow document plus a callback carrying the recognised text.
Point their "applet"/"answer URL" at `/telephony/generic/voice` and the callback
at `/telephony/generic/turn`; the adapter reads `Speech`/`transcript`/
`SpeechResult`. The document format differs, so swap `lib/telephony.js`'s
`twiml()` for that provider's flow JSON — the dialogue does not change.

**Language.** Add `?lang=hi` to the webhook URL to start in Hindi, or set the
language per caller from your own routing. The agent's lines are bilingual
(`{en, hi}` objects in `lib/dialogue.js`); add keys for the other eleven
languages the same way. Speech recognition language is set per call in the
`<Gather language="…">`.

## The human handover

Three paths, all of them end with a person:

- The console's **Take over the call** button — the agent stops speaking, the
  transcript stays live for the dispatcher.
- Two silent turns in a row → `needsHuman`, which shows up in the console list.
- In telephony, `expect: 'human'` returns `<Dial>` to `DISPATCHER_NUMBER`.

## Privacy — this is the part not to skip

- The consent line is spoken before anything else and is in the transcript.
- Transcripts carry a purge time; a sweeper runs every minute and actually
  erases them (`lib/sessions.js`), including a manual **Purge transcript**.
- Nothing is written to disk. Calls live in memory and die with the process —
  if you add persistence, encrypt it and keep the same retention rules.
- Logs carry call ids, not words. Do not add transcript logging.
- Under India's DPDP Act 2023 you need a notice in the caller's language, a
  stated purpose, a retention limit and a grievance contact. Those are product
  decisions, not code, and they need to be settled before a real call lands.

## What is not built

- **ASR quality is unproven.** This service consumes text from the provider's
  speech recognition. On noisy, emotional, code-mixed speech that recognition is
  the weakest link — benchmark it on real recordings before launch, and expect
  to add a second engine (IndicWhisper / Bhashini) for Indian languages.
- **No dispatch integration.** "Dispatch" here is an action list on a screen. A
  real deployment needs an integration with the responder (112/ERSS, a hospital,
  a private response partner) or a dispatcher who acts on it.
- **No recording storage, no auth on telephony webhooks** (Twilio request
  signatures should be verified), no rate limiting, no multi-tenant routing.
- **Two languages spoken by the agent.** The decoder understands cues across
  Hindi, Marathi, Tamil, Bengali and English, but the agent only speaks `en` and
  `hi` until the other line sets are written.

## Layout

```
server.js              http routes, SSE, retention sweeper
lib/dialogue.js        the state machine (pure, testable)
lib/decoder.js         explicit + coded signal sets, location and name extraction
lib/telephony.js       TwiML builder, provider input adapters
lib/sessions.js        in-memory store, purge, sweeper
public/console.html    dispatcher console
test/                  node:test — dialogue and HTTP
```
# raksha-112
