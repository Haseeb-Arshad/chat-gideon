# GIDEON conversational interface plan

## Revision 4 — signal to city landing page

The current conversational presence moves intact from `/` to `/agent`. The new root becomes GIDEON's public threshold: a restrained, motion-led introduction for people deciding whether to begin a conversation.

### Experience sequence

1. Open in near-darkness with the same deep-space atmosphere as the agent.
2. Let one warm red signal climb slowly through a sparse field of stars; nearby points notice it and make small, slightly uncanny course corrections.
3. As the visitor moves down the page, those scattered points gather into an abstract city/network horizon. The change explains GIDEON's value: scattered context becomes a direction you can act on.
4. Keep one primary action, `Meet GIDEON`, linked to `/agent`, with a quiet secondary scroll cue.
5. Preserve `/api/chat`, `/api/voice`, and `/api/config` unchanged.

### Visual system

- **Night** `#050608`: shared product background.
- **Carbon** `#090B0E`: near-field depth.
- **Signal red** `#FF4B3E`: the single moving beacon and CTA accent.
- **Living white** `#F6F8FF`: primary copy and stars.
- **Mist** `#9BA3AF`: secondary copy.
- **Deep plum** `#2D1522`: distant atmospheric warmth.
- Manrope remains the body/utility voice so the landing and agent feel related. `Instrument Serif` is introduced only for the landing's editorial display lines, giving the public page a more human rhythm without changing the product UI.

### Layout

```text
+--------------------------------------------------------------+
| GIDEON                                      About  Meet ->   |
|                                                              |
|         Intelligence that stays close to the signal.         |
|            supporting line + primary action                  |
|                                                              |
|                 ·       *                                    |
|                    red signal rises                           |
|              scattered lights subtly react                   |
|                         scroll ↓                              |
+--------------------------------------------------------------+
|  What to follow / what to mention        orbiting statements |
+--------------------------------------------------------------+
|     scattered lights converge into a quiet city horizon      |
|                    Meet GIDEON ->                             |
+--------------------------------------------------------------+
```

### Signature, motion, and restraint

The memorable element is the `signal journey`: a red beacon climbs, hesitates, then pulls a handful of independent stars into a coherent horizon. Motion is slow and ambient (8–18 second cycles), with one short page-load choreography and scroll reveals. There are no dashboard cards, gradient slogans, or decorative metrics. Reduced-motion mode freezes every element in a meaningful composed state; keyboard focus and mobile layout remain first-class.

### Verification and release gate

- `/` renders the new landing page at desktop and mobile widths.
- `/agent` renders the current voice experience without behavioral changes.
- Root navigation and all `Meet GIDEON` actions reach `/agent` without a reload.
- Typecheck/build and existing tests pass.
- Browser checks cover the root, `/agent`, reduced-motion-safe CSS, overflow, and console errors.
- Vercel deployment is only reported complete after a returned public URL and live checks of both routes. Local gates alone remain local proof.

## Revision 3 — luminous robot

The eye reference is direction, not an asset to reproduce. GIDEON becomes one compact circular machine with two white light-slits. The casing supplies the requested circle language; the eyes carry emotion through spacing, tilt, height, blink, and coordinated body motion rather than irises, lashes, brows, or human anatomy.

### Revised behavior

1. Keep the 30-second quiet pause, but move its explanation out of the face and into the voice controls below.
2. Start Fish generation as soon as the first complete sentence streams from the chat model. Prefetch following sentences while the current one plays.
3. Do not reveal the completed written answer before speech begins. During playback, reveal words against the audio clock so the caption feels spoken rather than dumped onto the page.
4. Pin the Fish request to the live-verified `alloy` voice identifier and prepend a restrained feminine delivery instruction so one warm adult female character persists across turns.
5. If voice is muted or unavailable, keep the normal streamed-text path so typing never waits on audio.

### Visual system

- **Deep space** `#050608`: the quiet canvas.
- **Machine black** `#0C0E12`: the circular face core.
- **Cold steel** `#8E97A3`: restrained casing highlights.
- **Living white** `#F6F8FF`: both eye-slits and spoken text.
- **Listening ice** `#BFE9FF`: the only bright state tint.
- **Edge cobalt** `#3148B8` and **ember plum** `#5B2D4F`: low-light background forms at the frame edges.
- Speech remains Manrope; state language remains IBM Plex Mono.

### Layout

```text
+--------------------------------------------------------------+
| GIDEON                                                [new]  |
|                                                              |
|                .------------------------.                    |
|              /     [ white ] [ white ]    \                  |
|             |       circular robot face    |                 |
|              \____________________________/                  |
|                                                              |
|                  word · by · word caption                    |
|                                                              |
|                 [ rounded live voice control ]                |
|              quiet-pause detail lives down here              |
|                   [ quiet typed fallback ↑ ]                  |
+--------------------------------------------------------------+
```

### Motion direction

The face is the only prominent actor. A blink compresses both slits, curiosity offsets their height, concern tilts them inward, delight lifts and widens them, and speech sends a subtle white pulse through the casing. The whole machine anticipates state changes with at most 4% deformation. Caption words enter from eight pixels below with blur-to-sharp focus in 220 ms. Controls settle in 180 ms and keep a 0.98 pressed state. Reduced-motion mode removes looping movement while preserving every state through shape and tone.

### Signature and critique

The signature is the contrast between a tactile circular machine and impossibly soft white light-slits. The previous iris-and-lid construction read as a human or feminine eye, which contradicted the brief. It is removed completely. The colorful perimeter in the reference is translated into two very dark, out-of-focus edge forms rather than copied decoration, keeping the product original and preventing the background from competing with the face.

## Revision 2 — living presence

The first interface proved the transport but presented GIDEON as a conventional dashboard and chat transcript. The approved redesign removes the rail, top bar, telemetry, bubbles, and decorative sci-fi framing. GIDEON becomes a full-screen voice presence whose eyes are the primary interface.

### Revised product behavior

1. Voice mode is enabled by default and attempts to listen when the experience loads.
2. A single rounded voice control always communicates one of three actions: mute, stop, or resume.
3. Thirty seconds without a final utterance pauses listening and exposes an explicit **Resume voice** action.
4. A completed spoken reply returns immediately to listening, creating a hands-free conversational loop.
5. Typed input remains available as a quiet fallback, not the center of the composition.
6. Only the latest human utterance and GIDEON reply appear as captions; conversation history remains contextual but is not rendered as chat bubbles.

### Revised visual system

- **Black glass** `#030405`: near-black canvas without dashboard panels.
- **Charcoal breath** `#111416`: depth around the face.
- **Living white** `#F4F6F3`: eyes and primary speech.
- **Iris blue** `#8EDCFF`: listening and focus.
- **Pulse violet** `#B79CFF`: thinking and curiosity.
- **Warmth** `#FFB38A`: happiness and laughter.
- Display and speech: Manrope with tighter, humanist composition.
- Utility: IBM Plex Mono only for tiny state language.

### Revised layout

```text
+--------------------------------------------------------------+
| GIDEON                                                [new]  |
|                                                              |
|                       ( expressive eyes )                    |
|                        state / emotion                       |
|                                                              |
|                 latest spoken reply as caption               |
|                     latest user phrase                       |
|                                                              |
|                 [ rounded live voice control ]                |
|                   [ quiet typed fallback ↑ ]                  |
+--------------------------------------------------------------+
```

### Motion direction

The eyes are the only prominent animated subject. Pointer gaze, irregular blinks, anticipatory focus, thinking saccades, speaking micro-squash, and smiling eye arcs map to real interaction states. User-triggered controls settle within 200 ms, active states deform by only 2%, and reduced-motion mode preserves emotion through shape and color without continuous movement.

### Revised signature and critique

The signature is not a glowing orb or assistant avatar. It is two large, responsive eyes in negative space: recognizably alive without pretending to be human. This avoids copying another product's exact face while preserving the requested immediacy and emotional presence. Decorative grids, glass cards, top navigation, telemetry, and bubble chronology are removed because they compete with the agent rather than making it feel present.

## Product boundary

GIDEON is a localhost-first, voice-forward conversational companion. Its single job is to let a person speak or type naturally, receive a fast streamed answer, and hear that answer in an expressive voice. The OpenRouter key stays on the server.

## Model path

- Conversation: `nvidia/nemotron-3.5-lightning:free`, selected after a live sub-second non-reasoning smoke test, with `minimax/minimax-m3:free` as a free fallback. Requests set reasoning effort to `none`.
- Spoken reply: `fish-audio/s2.1-pro-free:free` through OpenRouter's `/api/v1/audio/speech` endpoint.
- Spoken input: the browser Speech Recognition API for zero-cost, low-latency interim transcription on supported localhost browsers, with typed input as the universal fallback.
- Transport: server-side TanStack Start API routes. The browser never receives `OPENROUTER_API_KEY`.

## Experience

1. The assistant opens with one restrained greeting and three useful prompt starters.
2. Typed messages stream into the transcript immediately.
3. The talk control shows live listening/transcribing state and submits the final transcript.
4. Voice mode synthesizes each completed assistant reply with Fish Audio and plays it automatically.
5. Stop, mute, clear, retry, keyboard, reduced-motion, empty, unsupported-browser, missing-key, rate-limit, and provider-error states are explicit.
6. Conversation history remains local to the current browser session and is capped before sending to the model.

## Visual system

- **Void** `#05080A`: quiet page background.
- **Obsidian glass** `#0B1114`: conversation surfaces.
- **Signal cyan** `#73E7D1`: listening and live-response state.
- **Warm voice** `#F2B36B`: Fish speech/playback state.
- **Cloud** `#EDF4F2`: primary text.
- **Mist** `#8FA29E`: secondary text.
- Display type: Space Grotesk, used for the GIDEON wordmark and short state language.
- Body type: Manrope, optimized for conversational reading.
- Utility type: IBM Plex Mono, used only for model and session telemetry.

## Layout studies

Desktop keeps the live conversation central and makes voice state spatially persistent:

```text
+--------------------+-------------------------------------------+
| GIDEON / status    | conversation header         voice toggle |
|                    +-------------------------------------------+
| ambient voice orb  |                                           |
| live state + clock |           message transcript              |
|                    |                                           |
| session facts      | prompt starters / errors                  |
|                    +-------------------------------------------+
|                    | [ talk ] [ message................ ] [send]|
+--------------------+-------------------------------------------+
```

Mobile turns the status rail into a compact header and keeps the composer thumb-reachable:

```text
+--------------------------+
| GIDEON     online   voice |
| mini orb + live state     |
+--------------------------+
| transcript               |
|                          |
| prompt starters          |
+--------------------------+
| [talk] [message...] [go] |
+--------------------------+
```

## Signature

The signature is a single voice aperture: a layered, irregular waveform ring that changes from a slow resting breath to a directional listening pulse and a warm speaking glow. It represents the actual state machine rather than decorative animation.

## Self-critique before build

The existing cyan hologram treatment risks becoming a generic sci-fi dashboard. The revision keeps GIDEON's technological character but removes scanlines, excessive grids, fake capabilities, and scattered glow effects. One stateful voice aperture carries the theatrical moment; typography, surfaces, and motion elsewhere stay calm so the chat remains readable and credible.

## Verification gates

- TypeScript production build passes.
- Unit tests cover input validation and OpenRouter error normalization.
- Desktop and mobile browser passes cover send, streaming, new conversation, mute, keyboard focus, and microphone unsupported/permission states.
- The server returns a clear configuration error when `OPENROUTER_API_KEY` is absent.
- Live chat and Fish Audio proof are reported separately and require a locally supplied OpenRouter key.
