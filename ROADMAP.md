# GIDEON roadmap

> **Status.** Phases 0 through 3 are built and verified, and the anticipation
> work from Phase 4 landed with them. What shipped: the request guard, the
> AudioWorklet capture and VAD, clock-scheduled gapless playback, full-duplex
> barge-in with history truncation, speculative turns, the latency panel, the
> tool-calling agent loop, durable memory, the browser tool bridge, the action
> ledger, and a production server that hosts the realtime socket rather than
> falling back to HTTP. The README documents the result and its trade-offs.
>
> One correction to the plan below, learned by building it: Phase 4 assumed
> speculation could reuse the ordinary turn path unchanged. It cannot. A
> speculative turn that is byte-identical on the wire runs the server's whole
> tool loop, so a discarded guess really sets timers and really writes memory —
> and "unobservable" then means nothing. Speculative turns have to be declared
> as such and refused the *execution* of tools, while still being offered them,
> or a guess will confidently answer a question it never looked up.
>
> Still open, and still in the order below: streaming speech-to-text (which is
> what ends the Chrome/Edge restriction), on-device presence, back-channels, the
> WebRTC phone handoff, and prosody-driven emotion.

This document is the plan for turning GIDEON from a fast voice chat into the
kind of agent people recognise from films: something that is *in the room*,
already moving before you finish a sentence, able to act for you, and able to
follow you from one device to another. It is also the plan for making the repo
read as proof of real-time-communication expertise rather than a chat UI.

It is written against the codebase as of September 2026 (the realtime-link
branch: `agent-core.ts`, `realtime-session.ts`, `realtime-client.ts`,
`voice-queue.ts`, `listener.ts`, `GideonEyes.tsx`, `AgentPage.tsx`).

---

## 1. Where we are

### What is already good

- **Transport-free core.** `agent-core.ts` knows nothing about HTTP or sockets.
  The same generator drives the dev WebSocket and the serverless HTTP fallback.
- **One protocol, two transports.** `protocol.ts` frames are identical over
  WebSocket and newline-delimited HTTP, so the client has a single code path.
- **Pipelined speech.** `VoiceQueue` cuts the first chunk short (≤ 96 chars),
  generates up to three chunks ahead of playback, and meters playback amplitude
  through Web Audio to drive the face.
- **Stability endpointing.** `Listener` commits on transcript stability
  (420 / 700 / 1050 ms depending on how finished the phrase looks) instead of
  waiting for the recogniser's own `isFinal`.
- **A face that is actually animated.** Eye paths are rebuilt every frame from
  a pose interpolated by a critically damped spring; nothing goes through React
  state on the hot path.
- **Sensible latency hygiene.** Upstream TLS warm-up, `provider.sort:
  throughput`, `reasoning.effort: none`, bounded history.

### What holds it back

| Gap | Why it matters |
| --- | --- |
| **No real audio path.** Speech input is the browser Speech Recognition API (Chrome/Edge only, audio goes to Google, no control over endpointing or partials). Speech output is a whole MP3 per chunk. | This is the first thing an RTC reviewer looks for. There is no PCM capture, no VAD, no codec, no streaming STT/TTS, no jitter handling, no WebRTC. The "realtime" link carries JSON and blobs. |
| **Half-duplex.** `startListening` refuses to run while `thinking`, `replying` or `speaking`. | You cannot interrupt GIDEON by talking. Every consumer voice mode (ChatGPT, Gemini Live) has barge-in; without it GIDEON feels like a phone tree, however fast it is. |
| **Not actually always-on.** 30 s of silence pauses the mic; there is no wake word and no sense of whether anyone is there. | The brief is "stays there all the time, listening". |
| **Cannot act.** Chat only. No tools, no memory beyond 40 messages in `localStorage`. | The brief is "does stuff on my behalf". |
| **Production runs the worse path.** Vercel cannot hold a socket, so the deployed demo permanently degrades to HTTP after one 1.6 s probe. | The portfolio link shows the fallback, not the architecture. |
| **Chunk boundaries are audible.** Each chunk is a fresh `HTMLAudioElement`; there is no clock-scheduled hand-off, so tiny gaps and level jumps occur between chunks. | Fixable with `AudioBufferSourceNode.start(when)` on the AudioContext clock. |
| **Emotion is keyword regex.** `deriveEmotion` matches words like "lol" and "sorry". | Reads as random after a few turns. The eyes deserve a real signal. |
| **Free-tier models.** Rate limits and cold routing make demos flaky; the current models do not reliably support tool calling. | A portfolio demo has to work on the first try. |
| **Unprotected endpoints.** No origin check on the upgrade, no rate limiting on `/api/chat`, `/api/voice`, or socket frames. | A public URL is a free API key for anyone who finds it. |
| **Loose ends.** `/agent` is a `Hello "/agent"!` placeholder while `IMPLEMENTATION_PLAN.md` Rev 4 says the landing lives at `/` and the agent at `/agent`. The root `<title>` renders `â€”` (UTF-8 mojibake). Tests cover only `openrouter.ts` and `splitSpeakable`. | Small, but they are the first thing a visitor to the repo hits. |

---

## 2. The three signatures

These are the things GIDEON should be *known* for. Each is chosen because it is
(a) a real capability gap in shipping consumer voice agents, (b) a natural
showcase of real-time engineering, and (c) something you can demonstrate in a
30-second clip. Honesty note: pieces of these exist in research systems (Kyutai
Moshi is full-duplex; OpenAI's Realtime API truncates the assistant turn on
interruption). What no shipping product does is put them together, visibly, in
an open codebase you can read.

### Signature 1 — Anticipation: GIDEON acts before you finish speaking

Today every stage waits for the previous one: finish talking → endpoint →
transcript → LLM → speech. The endpoint alone costs 400–1000 ms of silence.

Instead, GIDEON works on the *interim* transcript:

- When the partial transcript has held still for ~300 ms but has not
  endpointed, a small fast model (or a rule set) predicts whether the utterance
  is probably complete and which tool it implies.
- **Speculative retrieval:** searches, page fetches and memory look-ups start
  immediately under a speculative id. When the final transcript lands, results
  are kept if the final text is a compatible extension of what was speculated
  on (normalised prefix match, then embedding similarity above a threshold);
  otherwise they are discarded and the HUD records a miss.
- **Speculative first token:** the LLM turn itself starts on the stabilised
  interim. If the final transcript matches, the already-streaming reply is
  committed and speech starts the moment you stop — perceived latency drops to
  near zero. If not, the stream is cancelled and a real turn starts (costs a
  few hundred wasted tokens, which is cheap).
- The latency HUD (Signature 4) shows it: "prefetched search 320 ms before you
  finished; hit."

Why it is distinctive: consumer assistants treat the endpoint as the starting
gun. Treating it as a *confirmation* is the same idea as speculative execution
in CPUs, applied to conversation, and it is exactly the kind of latency
thinking an RTC portfolio should show.

### Signature 2 — Presence: GIDEON knows you are in the room

A film agent does not need a button. It notices you.

- **On-device attention tracking (opt-in camera).** MediaPipe Face Landmarker
  (WASM/WebGPU, in a Web Worker, ~15 fps) gives face presence, head pose,
  gaze direction and a smile blendshape. Nothing leaves the browser; only a
  derived state (`present` / `attending` / `away`) ever reaches the model.
- **The eyes look at *you*,** not the mouse pointer. They track your face,
  hold eye contact while you speak, and glance away while thinking.
- **Look-to-talk.** Look at GIDEON and it lights up and listens; look away and
  it goes ambient. Gaze *is* the wake word. A spoken wake word ("Gideon", via
  an on-device keyword-spotting model such as openWakeWord through
  onnxruntime-web) is the hands-free alternative.
- **Arrival and departure.** Leave for ten minutes and come back and GIDEON
  greets you and picks the thread up. Look away mid-reply and it finishes the
  sentence, waits, and resumes with "anyway —" when you return.
- **Full duplex with barge-in.** The mic stays open while GIDEON speaks. If
  speech probability from the VAD exceeds threshold for ~180 ms during
  playback, playback fades out in 60 ms, pending synthesis is cancelled, and
  the assistant message in history is truncated to the words that were actually
  heard (the caption-progress tracker in `VoiceQueue` already knows this). The
  model sees `[interrupted after "…the second option"]`, so its next reply is
  coherent with what you heard, not what it wrote.
- **Back-channels.** During a long utterance (> 4 s) with a mid-sentence pause
  (VAD dip of 300–600 ms, no endpoint), GIDEON plays a short pre-synthesised
  acknowledgement ("mm-hm", "right") at low level, at most once every 6 s.
  These are generated once at boot and cached, so they cost nothing at
  runtime. This is the single most "alive" thing a voice agent can do, and no
  shipping assistant does it.
- **Emotion from the audio, not the words.** Pitch, energy and speech rate
  from the mic (in-browser DSP on the same AudioWorklet frames) drive the eyes
  *before* the words are understood, and are passed to the model as a short
  hint ("user sounds rushed"). The regex in `deriveEmotion` is retired.

### Signature 3 — Follow-me: GIDEON moves between your devices mid-conversation

Scan a QR on your phone and the phone becomes GIDEON's ears and mouth while the
desktop stays the brain and the screen. Walk out of the room and keep talking.

- **Session sharing first.** Both devices join the same server-side session
  id over the existing WebSocket; captions, phase and the face state are
  mirrored. This is robust and ships fast.
- **WebRTC audio second.** The phone sends its microphone as a WebRTC audio
  track to the desktop (signalling over the existing socket server, ICE with a
  TURN fallback). The desktop feeds that track into the same
  AudioWorklet → VAD → STT pipeline as its own mic, and returns GIDEON's voice
  as an outbound track. A DataChannel carries captions and state so the phone
  shows the eyes too.
- **Multi-party awareness (stretch).** Two people in the WebRTC session each
  have their own track, so per-track VAD tells GIDEON who is speaking. The
  eyes turn toward the speaker.

This is the piece that demonstrates WebRTC end to end: `getUserMedia`,
`RTCPeerConnection`, SDP negotiation, ICE/TURN, DataChannels, and mixing a
remote `MediaStreamTrack` into a Web Audio graph.

### Signature 4 (portfolio) — Glass box: every millisecond is visible

A latency HUD, toggled with a key, shows a per-turn waterfall:

```
speech end (VAD) ─┬─ endpoint decided       +180 ms
                  ├─ final transcript       +240 ms
                  ├─ speculative hit        (−410 ms saved)
                  ├─ LLM first token        +290 ms
                  ├─ first audio byte       +470 ms
                  └─ first sample played    +520 ms
```

Running p50/p95 for each stage is persisted and exported as JSON so the README
can quote real numbers. Every architectural claim in this document becomes a
measured one.

---

## 3. Target architecture

```
Browser ──────────────────────────────────────────────────────────────────────
  getUserMedia (AEC/NS/AGC on)
    └─ AudioWorklet: 16 kHz mono, 20 ms frames
         ├─ Silero VAD (onnxruntime-web)  ──► speech prob, endpoint, barge-in
         ├─ prosody features (pitch/energy/rate) ──► eyes + model hint
         ├─ wake-word spotter (ambient mode only)
         └─ ring buffer (300 ms pre-roll) ──► Opus (WebCodecs AudioEncoder)
                                                  │ binary frames
  Face Landmarker worker (opt-in camera) ──► present / attending / gaze
  Speech output: AudioContext clock ── AudioBufferSourceNode.start(when) ── gapless
  Presence engine: eyes, captions, HUD, back-channel bank
  Client tools: open URL, show card, clipboard, device state
        │  WebSocket (frames + binary audio)         │  WebRTC (phone remote)
────────┼────────────────────────────────────────────┼─────────────────────────
Realtime server (Node, long-lived; Fly.io / Railway / VPS in Docker)
  Session ← audio frames ──► streaming STT (Deepgram / AssemblyAI / self-hosted
                              faster-whisper) ──► partial + final transcripts
  Speculation manager: predicts completeness, starts tools/LLM early, commits or discards
  Agent loop: tool-capable LLM via OpenRouter ──► tool calls ──► server tools
              (search, fetch, calendar, timers, memory) and client-tool requests
  Streaming TTS (Fish Audio live WS / Cartesia / ElevenLabs) ──► PCM chunks +
              word timestamps ──► relayed as they arrive
  Memory: per-user store (SQLite/libsql or Postgres) with embedding retrieval;
          background extraction after each turn; proactive frames
  Signalling for WebRTC; origin check; token-bucket rate limits; access code
```

Design rules that carry over from today's code and must survive the rewrite:

1. The core stays transport-free. Audio in and out are `AsyncIterable` /
   `ReadableStream`s; sockets and WebRTC are adapters.
2. One protocol. New frame types are added to `protocol.ts`; binary audio is
   framed with a small header (`seq`, `pts`, `codec`) rather than a separate
   channel.
3. Everything degrades. No camera → no presence, everything else works. No
   streaming STT key → today's `Listener` (Web Speech) is the fallback. No
   socket → HTTP frames. No tools model → chat.
4. Nothing on the render hot path goes through React state.

---

## 4. Phases

Each phase ends with something demoable and a measured number. Order is chosen
so the RTC foundation lands before the features that depend on it, and so the
public demo improves after every phase.

### Phase 0 — Make the current build honest (1–2 days)

- Resolve the route mismatch: either build the Rev-4 landing at `/` and move
  the agent to `/agent`, or delete `agent.tsx` and the Rev-4 text. Fix the
  `â€”` title.
- **Deploy where sockets live.** Add a `Dockerfile` and deploy the Nitro
  server to Fly.io (or Railway/Render). Keep Vercel only if you want a static
  landing there. The demo link must exercise the WebSocket path.
- Origin check on the upgrade; per-IP token bucket on HTTP routes and socket
  frames; optional `GIDEON_ACCESS_CODE` for public demos; `/healthz`.
- Tests for `Listener` endpointing (fake recogniser), `RealtimeLink` (fake
  socket, fallback probe), `createRealtimeSession` (fake sink), and the
  `agent-core` SSE parser. GitHub Actions: typecheck, test, build.
- Switch the demo to a paid, tool-capable, fast model through OpenRouter (keep
  the free ones as fallbacks). Cost is a few dollars a month at demo volume.

### Phase 1 — A real audio path (1–2 weeks)

- `AudioWorkletProcessor` capturing 16 kHz mono 20 ms frames into a
  `SharedArrayBuffer` ring; energy and pitch estimation on the worklet thread.
- Silero VAD through onnxruntime-web (WASM, WebGPU when available). Endpoint
  rule: VAD silence ≥ 250–400 ms *and* STT stability, whichever the HUD proves
  faster without clipping.
- Opus via WebCodecs `AudioEncoder` (PCM16 fallback), sent as binary frames
  with `seq`/`pts`. Server forwards to streaming STT; `partial` and `final`
  transcript frames come back. `Listener` becomes one of two `SpeechSource`
  implementations; the other is the new streaming one. Firefox and Safari
  start working.
- Playback rewrite: decode each arriving chunk and schedule it on the
  AudioContext clock for gapless output; caption highlight driven by real
  chunk timing (word timestamps where the provider supplies them).
- Streaming TTS direct from a provider that streams PCM (Fish Audio's live
  WebSocket, Cartesia, ElevenLabs). OpenRouter's `/audio/speech` is
  request/response and caps first-audio latency; keep it as the fallback.
- Latency HUD v1 with the waterfall above.

Measured target: first audible sample within ~600 ms of speech end at p50.

### Phase 2 — Full duplex (1 week)

- Mic stays open during playback. Barge-in as described in Signature 2, with
  an echo guard: ignore mic energy that correlates with the playback level
  already being metered.
- Interruption-aware history: truncate the assistant message to spoken words
  and append the interruption marker.
- Back-channel bank synthesised at boot; trigger on intra-utterance pauses.
- Prosody hint to the model; eyes react to user tone before words arrive.

### Phase 3 — Hands: GIDEON acts on your behalf (1–2 weeks)

- `streamTurn` becomes an agent loop yielding `tool_call`, `tool_result` and
  `delta` frames. Server tools: web search (Tavily/Brave/Exa), fetch-and-read,
  timers and reminders, notes, calendar (CalDAV or Google), memory read/write,
  optional sandboxed code execution.
- **Client-side tools** through the protocol: the server sends
  `tool_request`, the browser fulfils it (open a URL in a tab, show a rich
  card next to the face, read the clipboard, report device state) and replies
  with `tool_result`. This bidirectional tool bus is a good architecture story.
- **Action ledger.** Every action GIDEON takes is listed with its arguments
  and an undo where one exists. Voice agents that act need to be auditable.
- **Memory.** Background extraction of durable facts after each turn into a
  per-user store; retrieval by embedding at turn start; a "what do you
  remember about me" that is answerable and editable.
- **Proactive turns.** Reminders and follow-ups arrive as `proactive` frames.
  The client only lets GIDEON speak first if presence says someone is there.

### Phase 4 — Anticipation (1 week)

- Speculation manager on the server: completeness prediction on stabilised
  partials, speculative tool runs and speculative LLM start, commit/discard on
  final transcript, hit/miss accounting to the HUD.
- Tuning is empirical: log speculation accuracy and wasted tokens for a week
  and pick thresholds from the data. Publish the numbers.

### Phase 5 — Presence (1–2 weeks)

- Face Landmarker in a worker; `present` / `attending` / `away` state machine
  with hysteresis; eyes track the face; look-to-talk; arrival and departure
  behaviours; smile mirroring.
- Wake word through an on-device spotter; "ambient" mode where nothing is sent
  anywhere until addressed by gaze or name.
- Permission onboarding that explains what stays on-device.

### Phase 6 — Follow-me (1–2 weeks)

- Session sharing across devices by id (QR from the desktop).
- WebRTC phone remote: signalling over the socket server, `RTCPeerConnection`
  with TURN (coturn in the same Docker deployment, or a hosted TURN), remote
  mic track fed into the Worklet pipeline, GIDEON's voice returned as a track,
  DataChannel for captions and state.
- Stretch: per-track VAD for multi-party awareness.

### Phase 7 — Portfolio finish (3–4 days)

- 30–45 s demo video: interrupt GIDEON mid-sentence; watch the HUD show a
  speculative hit; look away and back; hand off to a phone.
- README: architecture diagram, measured latency table, a "Decisions" section
  (or `docs/adr/`) explaining why WebSocket + WebCodecs before full WebRTC,
  why VAD + stability endpointing, why speculation is safe, why perception is
  on-device.
- Playwright end-to-end test that drives a real voice turn in CI using
  Chromium's fake media device with a WAV fixture. This alone tells a reviewer
  you have built and tested audio pipelines before.
- Live demo behind an access code so the key survives.

---

## 5. Decisions to make early

- **Streaming STT provider.** Deepgram is the least friction for a portfolio
  demo; self-hosted `faster-whisper` streaming is the most impressive and the
  most work. Design `SpeechSource` so both fit.
- **Streaming TTS provider.** Whichever streams PCM with word timestamps and
  has a stable voice you like. Keep OpenRouter TTS as the fallback path.
- **WebSocket + WebCodecs first, WebRTC second.** WebRTC (via LiveKit or a Node
  stack such as `werift`) is the textbook transport for browser audio, but it
  adds an SFU or a media server to run. The socket path with our own framing,
  Opus encoding and a small jitter buffer is fully demonstrable and simpler;
  the phone-remote feature in Phase 6 is where WebRTC earns its keep. Write
  this trade-off down in the README rather than hide it.
- **Hosting.** Fly.io or Railway for the long-lived Node server. Vercel is
  fine for a static landing only.
- **Landing page.** Decide whether the Rev-4 landing happens; if not, delete
  its traces so the repo tells one story.

---

## 6. Everything-else polish

Small things that make "everything good enough" true:

- Safari and Firefox support falls out of Phase 1 (no more Web Speech
  dependency).
- Installable PWA with a persistent notification for ambient mode; keyboard
  push-to-talk (hold Space); a settings drawer (voice, wake word, camera,
  HUD).
- Mobile layout for the face and captions; the phone-remote page reuses it.
- Reduced-motion and screen-reader paths already exist; keep them for every new
  surface (the HUD and action ledger especially).
- Rate-limit and error copy stays in GIDEON's voice; never a raw provider
  message.
