# Fonts

GIDEON is set in two faces:

| Role | Face | Where it is used |
| --- | --- | --- |
| Display | **GT Alpina Condensed** (Grilli Type) | The spoken line, the transcript, headings |
| Text | **Frances** | UI text, the composer, buttons, labels |

Both are licensed, so most of the files are **not** committed here — only the
weights already dropped in are present. The `@font-face` rules in
`src/styles.css` point at this directory and accept either `.woff2` or
`.woff`; add a file with the exact name below and it takes over on the next
page load. Nothing else needs changing.

```
public/fonts/
  GT-Alpina-Condensed-Light.woff(2)          ← in place
  GT-Alpina-Condensed-Light-Italic.woff(2)   ← in place
  GT-Alpina-Condensed-Regular.woff(2)        ← not yet added
  GT-Alpina-Condensed-Medium.woff(2)         ← not yet added
  Frances-Regular.woff(2)                    ← not yet added
  Frances-Medium.woff(2)                     ← not yet added
  Frances-Semibold.woff(2)                   ← not yet added
```

You do not need the full set. `font-synthesis: none` is set globally, so a
weight that has no matching file just renders at the nearest weight that
*is* registered rather than a faked bold/italic — right now every GT Alpina
element renders as Light (300) until Regular or Medium show up.

If a heavier or condensed-differently cut arrives under a name that doesn't
match this list, add its own `@font-face` block following the same pattern
rather than renaming the file to fit — the naming here just tracks what
Grilli Type happened to export first.

## Until then

The stacks in `src/styles.css` name a free stand-in behind each licensed face,
chosen to sit in roughly the same place so the page never renders unstyled:

- `--font-display`: GT Alpina → **Fraunces** → Iowan Old Style → Georgia
- `--font-text`: Frances → **Manrope** → Segoe UI → system-ui

Fraunces and Manrope are loaded from Google Fonts at the top of the stylesheet.
For any weight whose file is still missing, the browser will log a 404 before
falling back; that is expected, not a bug. Once every real file lands you can
drop the Google Fonts `@import` if you want the page to stop reaching out to a
third party.

## Converting from OTF/TTF

If your licence delivers desktop formats, convert before dropping them in —
`.woff2` is roughly half the size of `.woff`, and both are accepted:

```bash
npx woff2 GT-Alpina-Condensed-Regular.otf
```
