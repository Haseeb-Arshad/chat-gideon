# GIDEON

A voice presence you can talk over, that starts working before you finish your
sentence, and that shows you exactly where every millisecond went.

Most voice assistants are walkie-talkies wearing a personality. You speak, they
wait to be sure you have stopped, then they think, then they talk, and while
they are talking they are deaf. GIDEON is built against those three specific
properties.

```text
you stop talking ──► detector endpoints ──► model ──► speech
                     ▲                                  │
                     └── the entire cost of a turn, in series
```

---

## The three things it does differently

### 1. It answers before you finish asking

Every voice agent treats the endpoint — the moment a detector decides you have
stopped — as a starting gun. But the endpoint exists to establish *that* you
finished, which is a different question from *what you said*. Waiting for it
puts the detector's hangover and the whole model round trip in series, on every
single turn.

GIDEON treats the endpoint as a **confirmation** instead. Once the interim
transcript holds still and looks like a complete phrase, the turn is already
sent under a hidden id. When the endpoint lands a few hundred milliseconds
later, the reply is mid-stream: it is either promoted — releasing everything
buffered into the caption and the voice at once — or thrown away unseen.

This is speculative execution, and it carries the same obligation: **a
misprediction has to be unobservable, not merely unlikely.** Nothing
speculative is ever shown, spoken, or written to history, and the commit test
in [`speculation.ts`](src/lib/speculation.ts) is strict on purpose:

| Final transcript vs. the guess | Decision |
| --- | --- |
| Identical after normalisation | commit |
| Guess + up to 3 words of pure filler (`please`, `thanks`) | commit |
| A word changed anywhere | discard |
| Guess ran ahead of what was actually said | discard |
| A trailing negation (`not`, `instead`, `wait`) | discard |
| A tail long enough to be a second sentence | discard |

A wrong answer delivered quickly is worse in every way than a right one
delivered late. The hit rate and the time it actually bought are both on screen
(below), so the trade is measured rather than asserted.

### 2. You can talk over it

The microphone stays open while GIDEON is speaking. Sustained speech fades him
out over 60 ms and hands the floor straight back — with no microphone restart,
because you are already mid-sentence and a restart would eat the word you cut
in on.

His own voice cannot trigger it. The detector's threshold is raised while the
speakers are live, on top of the browser's echo cancellation, so the residual
is quiet and a real interruption is not.

The part that matters for the *next* turn: the interrupted reply is truncated in
history to **the words that were actually heard**, read off the playback clock,
and marked `[interrupted]`. Leaving the full text in place would mean GIDEON
reasons about a paragraph you never received, and the conversation quietly
diverges from the one you are having.

### 3. It acts, and hands you the receipt

The turn is an agent loop, not a chat completion. It can read the clock,
remember durable facts about you, recall and forget them, search the web, set a
timer, and put a link on screen.

Two of those can only happen in the browser — a timer has to live where the
page lives, a link has to be offered to whoever is looking at the screen — so
the socket carries a request *from* the server and waits for the browser's
answer. That is the first thing the realtime transport can do that a streaming
HTTP response genuinely cannot.

Everything it does lands in a ledger under the captions. An agent that only
talks needs no receipt; one that stores facts and sets timers does, because
spoken confirmation disappears the moment it is said. Links are rendered as a
card and **never** opened for you: the scheme is whitelisted to `http`/`https`,
and the decision to act stays with the person — the only safe place for it when
the instruction originated in a language model.

### And a fourth, for the sceptic: the glass box

Press `` ` `` (backtick). Every other part of GIDEON hides its machinery; this
panel exists to show it — the last turn as a waterfall, the session as
nearest-rank percentiles, and the speculative hit rate beside the milliseconds
it saved. **Copy JSON** exports the raw marks.

```text
speech end (VAD) ─┬─ endpoint decided
                  ├─ turn sent
                  ├─ first token
                  ├─ voice returned
                  └─ first sound heard      ← the only number a person feels
```

Percentiles are nearest-rank rather than interpolated: a session produces
twenty-odd turns, and an interpolated p95 invents a number between two real
observations and reads as more precise than the sample supports.

---

## How it works

```text
Browser ──────────────────────────────────────────────────────────────────────
  getUserMedia (AEC/NS/AGC on)
    └─ AudioWorklet ── 20 ms frames ── RMS · zero-crossing rate · low-band share
         ├─ VAD ──► endpoint  (commits the turn, ahead of the recogniser)
         ├─ VAD ──► barge-in  (threshold raised while the speakers are live)
         └─ level ──► the eyes
  SpeechRecognition ──► interim words ──► stability tick ──► speculative turn
  Playback: AudioContext clock ── AudioBufferSourceNode.start(when) ── gapless
                                        │ caption + eye level read this clock
        │ WebSocket (JSON frames + binary audio)
────────┼─────────────────────────────────────────────────────────────────────
Node server (the same core runs in the Vite dev host and a built Nitro server)
  agent loop ──► OpenRouter (streamed, tools attached)
       ├─ server tools: clock · memory · web search
       └─ client tools: tool_request ──► browser ──► tool_reply
  memory: IDF-ranked facts, merged on restatement, evicted by usefulness
  guard: origin · optional access code · per-caller token buckets
```

Three properties hold throughout, and they are what keep the thing honest:

1. **The core is transport-free.** [`agent-core.ts`](src/lib/agent-core.ts)
   imports no framework, so the identical generator drives the dev WebSocket
   host and the serverless HTTP route.
2. **One protocol, two transports.** The frames in
   [`protocol.ts`](src/lib/protocol.ts) are the same over a socket and over
   newline-delimited HTTP, so the browser never branches on transport. The one
   exception is `tool_request`, which needs a reply channel — and the agent
   loop is told up front whether it has one rather than discovering it half way
   through a turn.
3. **Everything degrades.** No microphone → typing. No `SpeechRecognition` →
   typing. No socket → HTTP frames, minus browser tools. No search key → it
   says so instead of guessing. No tool support in the model → one retry
   without tools, then plain conversation. No writable disk → memory lasts the
   process.

Nothing on a render hot path goes through React state. The eyes rebuild their
SVG paths every frame from springs written straight to the DOM; the VAD runs on
the audio thread; sixty level updates a second travel by ref.

---

## Decisions worth arguing with

**Lexical memory retrieval, not embeddings.** An embedding index ranks better
and costs an API round trip on the critical path of *every* turn. In a voice
loop where the whole budget to first sound is a few hundred milliseconds, that
is the most expensive place in the system to spend one. Inverse document
frequency over a few hundred short facts runs in microseconds. Light suffix
stripping came directly out of a failing test: without it, "what do I play"
does not match "the user plays the cello", which is the ordinary case rather
than an edge one.

**A hand-written VAD, not Silero.** The features in
[`audio/vad.ts`](src/lib/audio/vad.ts) — energy, zero-crossing rate, and the
share of energy below ~1 kHz — take microseconds per frame, need no download,
and work offline. `FrameFeatures` is the seam a neural detector slots into if
one earns its weight. The noise floor is asymmetric on purpose: it falls fast
and rises over tens of seconds, because a symmetric follower learns the
speaker's own voice as "the room" within a sentence or two and then goes deaf
to them. That is the classic way a naive energy detector fails.

**WebSocket + our own framing before WebRTC.** WebRTC is the textbook transport
for browser audio, but it adds an SFU or media server to operate. The socket
path with our own frames is fully demonstrable and much simpler to host. WebRTC
earns its place when there is a second device in the picture — see below.

**Scheduled playback, not chained media elements.** One `HTMLAudioElement` per
chunk hands the timing to the main thread, so the seam between chunks is
however long an `ended` event, a constructor and a `play()` take. It is small,
variable, and audible. Scheduling against `AudioContext.currentTime` — a sample
counter on the audio thread — makes chunk two start on the sample after chunk
one ends, whatever the page is doing.

**Two tool rounds, maximum.** Each round is another model round trip with the
user sitting in silence. Two covers the realistic shapes (look something up
then answer; recall then act), and a model that wants a third is usually
looping.

**Token buckets, not fixed windows.** A fixed window lets a caller spend a full
quota either side of the boundary, and a voice turn is bursty enough for that
to matter.

---

## Run it

```bash
npm install
cp .env.example .env    # then put your OpenRouter key in it
npm run dev
```

Open <http://localhost:3000> in Chrome or Edge and allow the microphone. Voice
starts listening on its own.

Firefox and Safari currently fall back to typing, because live transcription
still comes from the browser `SpeechRecognition` API. The capture, VAD,
barge-in and playback pipeline is standard Web Audio and already works
everywhere; swapping in a streaming speech-to-text provider behind the
`SpeechSource` seam is what removes that limitation.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | Server-only bearer token |
| `OPENROUTER_CHAT_MODEL` | `openai/gpt-4.1-mini` | Must support tool calling for GIDEON to act |
| `OPENROUTER_CHAT_FALLBACK_MODEL` | `minimax/minimax-m3:free` | Free fallback |
| `OPENROUTER_VOICE_MODEL` | `fish-audio/s2.1-pro-free:free` | Speech synthesis |
| `OPENROUTER_VOICE` | `alloy` | Voice identifier |
| `GIDEON_MEMORY_PATH` | unset | Where facts persist; unset means per-process |
| `TAVILY_API_KEY` | unset | Enables `web_search` |
| `GIDEON_ACCESS_CODE` | unset | Required on every request when set |
| `GIDEON_ALLOWED_ORIGINS` | same-origin | Only if the page is embedded elsewhere |
| `PORT` | `3000` | Dev server and realtime socket |

Never rename the key to a `VITE_` variable. Vite exposes `VITE_` variables to
browser code; GIDEON keeps this credential in server routes only.

### Controls

- Talk. It listens, answers, and goes back to listening.
- **Talk over it** to interrupt.
- `` ` `` toggles the latency panel.
- Type and press Enter as a fallback; Shift+Enter for a newline.
- The square control stops a reply; **New** clears the conversation and ledger.
- Thirty seconds of quiet pauses the microphone.

Conversation history stays in this browser's local storage. Memories are the
only thing that leaves it, and only to the server you are running.

---

## Verify

```bash
npm test          # 184 tests
npx tsc --noEmit
npm run build
```

The suite covers the parts where being wrong is silent: VAD state transitions
and echo-guard behaviour, the speculative commit rule, latency percentiles,
memory ranking and eviction, URL scheme rejection, rate-limit buckets, origin
and constant-time access-code checks, dash-stripping across a token stream, and
the mood plane.

Deploying anywhere that cannot hold a WebSocket (Vercel and other serverless
hosts) silently drops to the HTTP path and loses browser-run tools. A
long-lived Node host — Fly.io, Railway, a VPS — exercises the real
architecture.

---

## What is not built yet

Honest list, in the order I would do them:

- **Streaming speech-to-text** behind the `SpeechSource` seam, which is what
  ends the Chrome/Edge restriction and puts endpointing entirely under our
  control.
- **On-device presence.** Face landmarking in a worker so the eyes track *you*
  rather than the pointer, look-to-talk as a gaze wake word, and picking the
  thread back up when you return. Nothing would leave the browser but a
  `present`/`attending`/`away` state.
- **Back-channels** — a quiet "mm-hm" during your long utterances, from a bank
  synthesised once at boot. The most "alive" thing a voice agent can do, and no
  shipping assistant does it.
- **Follow-me.** Scan a QR and your phone becomes the ears and mouth over a
  real WebRTC peer connection while the desktop stays the brain. This is where
  WebRTC earns its keep: SDP, ICE/TURN, a DataChannel for captions, and mixing
  a remote track into the same Web Audio graph.
- **Prosody-driven emotion.** Pitch, energy and rate from the frames already
  being computed, so the eyes react to *how* you said it before the words are
  understood.
