# Models

`silero_vad_v5.onnx` is Silero VAD v5, the voice activity detector from
[snakers4/silero-vad](https://github.com/snakers4/silero-vad), released under
the MIT License by the Silero team. This copy came from the
[`@ricky0123/vad-web`](https://github.com/ricky0123/vad) 0.0.30 package.

SHA-256: `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`

GIDEON uses it in the browser to decide whether a sound is someone speaking,
so that a fan or a keyboard cannot interrupt a reply. See
`src/lib/audio/silero.ts`.
