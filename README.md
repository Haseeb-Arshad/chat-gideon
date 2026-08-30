# GIDEON

GIDEON is a localhost-first, voice-forward conversational presence. Its expressive eyes listen, focus, think, speak, and smile while the latest exchange appears as live captions rather than chat bubbles.

## What it uses

- **Conversation:** `nvidia/nemotron-3.5-lightning:free` on OpenRouter, with `minimax/minimax-m3:free` fallback
- **Voice output:** `fish-audio/s2.1-pro-free:free` on OpenRouter, pinned to the live-verified `alloy` voice with a warm feminine delivery
- **Voice input:** the browser Speech Recognition API (Chrome or Edge recommended)
- **App:** TanStack Start, React 19, TypeScript, Tailwind CSS 4

GIDEON sends `reasoning.effort: "none"` and excludes reasoning output so replies begin quickly. The primary model produced a live non-reasoning response in about one second during the verification pass. Every configured model is a free variant intended for local testing, so an upstream free pool may still be rate-limited.

## Run locally

1. Copy the example environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Put your OpenRouter key in `.env`:

   ```dotenv
   OPENROUTER_API_KEY=your_key_here
   ```

3. Start the app:

   ```powershell
   npm install
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in Chrome or Edge. Voice mode starts enabled and asks for microphone access automatically.

Never rename the key to a `VITE_` variable. Vite exposes `VITE_` variables to browser code; GIDEON keeps this credential exclusively in server routes.

## Conversation controls

- Voice mode listens, sends a final utterance, speaks the answer, and then returns to listening automatically.
- The first complete sentence is sent to Fish while the rest of the answer streams; captions then reveal word by word with playback.
- Thirty seconds without speech pauses the microphone. Select **Resume voice** to continue.
- Select the rounded **Voice live** control to mute listening and playback at any time.
- Type and press **Enter** to send; use **Shift + Enter** for a new line.
- The square stop control interrupts a streamed answer or active playback.
- **New conversation** clears the local transcript.

Conversation history is saved only in the current browser's local storage. The server sends at most the most recent 24 messages to OpenRouter.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | Server-only OpenRouter bearer token |
| `OPENROUTER_CHAT_MODEL` | `nvidia/nemotron-3.5-lightning:free` | Fast, free text model |
| `OPENROUTER_CHAT_FALLBACK_MODEL` | `minimax/minimax-m3:free` | Free non-reasoning fallback |
| `OPENROUTER_VOICE_MODEL` | `fish-audio/s2.1-pro-free:free` | Free Fish Audio speech model |
| `OPENROUTER_VOICE` | `alloy` | Consistent voice identifier accepted by the Fish endpoint |
| `OPENROUTER_SITE_URL` | `http://localhost:3000` | OpenRouter app attribution URL |

## Architecture

```text
Browser microphone ──> Speech Recognition ──> transcript
                                                 │
Typed message ───────────────────────────────────┤
                                                 ▼
                                      POST /api/chat
                                                 │ server-only key
                                                 ▼
                                   OpenRouter chat stream
                                                 │
                                visible text <───┘
                                      │
                                      ▼
                               POST /api/voice
                                      │ server-only key
                                      ▼
                          Fish Audio MP3 response ──> playback
```

The browser calls same-origin TanStack Start server routes. Those routes validate and bound input, add GIDEON's conversational system prompt, normalize provider failures, and proxy streaming text or MP3 bytes without returning the API key.

## Verify

```powershell
npm test
npx tsc --noEmit
npm run build
```

The tests cover request validation, bounded history, and provider-error normalization. A live text/audio smoke test additionally requires a valid `OPENROUTER_API_KEY`.

## Deploy to Vercel

GIDEON is a single TanStack Start application. Nitro packages the page and `/api/*` server routes together, so no separate `services/api` rewrite is needed.

```powershell
npx vercel
npx vercel env add OPENROUTER_API_KEY production
npx vercel --prod
```

Add the key through Vercel's environment settings or CLI, and optionally set `OPENROUTER_SITE_URL` to the deployed URL. Never expose the key through a `VITE_` variable.

## Model references

- [Fish Audio S2.1 Pro Free on OpenRouter](https://openrouter.ai/fish-audio/s2.1-pro-free:free)
- [OpenRouter text-to-speech guide](https://openrouter.ai/docs/guides/overview/multimodal/tts)
- [OpenRouter chat streaming quickstart](https://openrouter.ai/docs/cookbook/get-started/quickstart)
