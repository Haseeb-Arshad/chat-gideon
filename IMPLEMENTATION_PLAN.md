# GIDEON conversational interface plan

## Product boundary

GIDEON is a localhost-first, voice-forward conversational companion. Its single job is to let a person speak or type naturally, receive a fast streamed answer, and hear that answer in an expressive voice. The OpenRouter key stays on the server.

## Model path

- Conversation: `google/gemma-4-26b-a4b-it:free`, a free instruction model whose catalog reports reasoning disabled by default. Requests also set reasoning effort to `none`.
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

