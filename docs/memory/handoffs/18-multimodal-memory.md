# Stage 18 handoff: optional multimodal memory with modality-specific consent

Status: LOCAL_VERIFIED (optional; SQLite only; not wired into ChatGideon; image and speech understanding are fixture interpreters)
Implementation commits:
- `f5a589a`: consented asset store, derived evidence, historical-observation recall, deletion-fenced parse jobs, display pinning, export
- `15335da`: an interpreter claims only the uploads it can read
- `1d23cc7`: inspector view for media assets
- `c5eb469`: derived items listed in the order they were made
- `a47fa15`: a refused SQLite store closes its file before reporting the error
- the commit that adds this handoff

Date: 2026-09-25
Environment: Windows 10, Node 22.13 (`node:sqlite`). No provider calls, deployment, downloads or real-user media.

## Prerequisite evidence

Stage 16 (`handoffs/16-independent-framework.md`): the portable package,
host-supplied scope and principal binding, typed errors and `BEGIN IMMEDIATE`
writes. The asset store follows the same shape as the Stage 17 procedure
store: a separate optional SQLite store, not part of the backend contract.

## Implemented behavior (`packages/memory/src/assets.ts`)

- **Modalities and formats** (`MODALITY_TYPES`): image (`image/png`,
  `image/jpeg`, `image/webp`), document (`application/pdf`, `text/plain`,
  `text/markdown`), audio (`audio/wav`).
- **Consent per modality** (`setConsent`), each off by default:
  - `raw`: keep the original bytes;
  - `derived`: keep descriptions, OCR text and transcripts;
  - `retentionDays`: 1–3650, or none;
  - `embeddings`: always `false`; asking for them is refused as `unsupported`.

  Text memory consent never implies media consent. Withdrawing `raw` or
  `derived` purges what that consent covered, immediately.
- **Upload boundary** (`ingest`):
  - URLs are refused; the store never fetches anything;
  - the declared type must match the file's magic bytes (`sniff`);
  - per-modality size limits (image 10 MiB, document 20 MiB, audio 25 MiB)
    and a 200 MiB budget per scope (`DEFAULT_ASSET_LIMITS`, configurable);
  - raw bytes go to an owner-only object directory under a random name
    (`0600`/`0700` on POSIX; Windows ACLs are not changed; not encrypted).
- **Immutable revisions.** Each upload to an asset id is a new revision with
  content type, size, source time, receive time and provenance. Earlier
  revisions are never overwritten.
- **Derived evidence** (`interpretAndCommit`, `processPending`): every item
  records its producer and version, a source region (image) or time span
  (audio) and a confidence. Parse jobs carry the scope's deletion epoch and a
  fence. A job whose asset was deleted, or whose epoch moved, cannot commit.
  An interpreter claims only jobs for types it reads. On an outage a job is
  retried up to three times, then marked failed; the upload stays
  uninterpreted and recall says nothing about it.
- **Interrupted audio.** WAV headers give the declared length and the bytes
  give what arrived. Transcript spans are clamped to what arrived, and spans
  past it are dropped.
- **Recall** (`recall`): accepted derived items only. Each hit is marked
  `historicalObservation: true` with the capture date, a note that it
  "describes that moment, not how things are now", `sourceAvailable`
  (whether the original can still be fetched) and `supersededByRevision`.
  `fetchSource` returns bytes only when raw consent kept them.
- **Display pinning** (`recordDisplay`, `resolveDisplay`): which exact
  revision a conversation showed at a given step. "The picture you showed me"
  resolves to that revision, and a display that was never recorded is refused.
- **Deletion** (`deleteAsset`, `applyRetention`, consent withdrawal):
  - removes raw bytes, derived text and search terms;
  - clears provenance and content hashes;
  - moves the deletion epoch, so a running parse cannot commit.

  Display pins remain, but they resolve to `deleted`. Ids, dates and sizes
  stay as a tombstone, and a re-upload to a deleted id is refused.
- **Inspector** (`inspect`): each revision with what was kept, and each
  derived item with producer, region or span, and confidence. A deleted asset
  shows only that it existed.
- **Export** (`exportAll`): derived text only under derived consent. Raw bytes
  only when explicitly requested and still kept.

## Matched comparison

Source: `docs/memory/reports/stage-18-multimodal-eval.json`. 13 held-out
questions ran against the same memory in two arms: text-only (what the user
said in conversation) and text plus consented assets. The media were
generated in the test: PNGs built from pixels, WAVs from a sine wave, and text
documents. No files were downloaded, and no private media was used.

| Category | Text-only | Multimodal |
|---|---|---|
| Document reference | 0/4 | 4/4 |
| Image reference | 0/2 | 2/2 |
| Stale scene ("what does it look like now") | 2/2 | 2/2 (answers only as a dated observation) |
| Interrupted audio | 1/2 | 2/2 (answers what arrived, abstains on what was cut) |
| Negative personalization | 2/2 | 2/2 |
| Deleted asset | 1/1 | 1/1 |
| **Total** | **6/13** | **13/13** |

Image and speech understanding come from labelled fixture interpreters, so
this measures the pipeline (reference, time, deletion, restraint), not a
vision or speech model. Text-only passes the stale-scene questions because it
has no scene to present. The comparison checks that the multimodal arm keeps
that restraint.

## Verification

| Command | Result |
|---|---|
| `npx vitest run packages/memory` | 57 passed, 1 skipped (live PostgreSQL) |
| `npx vitest run` | 112 files passed, 15 skipped; 1119 tests passed, 108 skipped |
| `npx tsc --noEmit` | clean |
| `npm run memory:postgres:test` (disposable PostgreSQL) | 76/76 |
| packages PostgreSQL conformance + cutover (harness) | 19/19 |
| Node and Cloudflare builds, Worker bundle and secret checks | pass |

After a full run, `git checkout -- docs/memory/reports/`, because tests
regenerate the stage reports.

Seed cases (`packages/memory/test/assets.test.ts`):

| Case | Evidence |
|---|---|
| C01, C17 | "C01/C17: "the picture you showed me" resolves to the revision on screen; a display never issued is refused" |
| C16 | "C16: an interrupted recording is transcribed only for what arrived" (the inspector shows the clamped spans) |
| C22 | "C22: deleting during a parse removes the bytes and the parse cannot recreate derivatives" |
| C24 | "C24: another principal or scope gets no asset, description or source" |
| C35 | "C35: an image description is a dated observation of that revision, not the room today" |

Also covered:
- consent separation: "keeps nothing without consent…" and "raw-only keeps
  the bytes…";
- upload boundary: "refuses URLs, type mismatches…";
- outage: "a provider outage leaves the upload uninterpreted…";
- claim filter: "an interpreter claims only the uploads it can read…";
- withdrawal and retention: "withdrawing derived consent…";
- export: "exports derived text only…";
- missing-source uncertainty: `sourceAvailable: false` with "cannot be
  re-checked" in the note.

## Decisions and limits

- **No real interpreters ship.** Only `TEXT_DOCUMENT_INTERPRETER`
  (plain text and Markdown) is built in. PDF parsing, OCR, image description
  and speech recognition need a host-supplied `AssetInterpreter`. Until one
  is provided, those uploads stay uninterpreted.
- **Unsupported:**
  - embeddings;
  - thumbnails (none are generated, so there are none to delete);
  - face or voice identity linking;
  - sensitive-trait extraction;
  - URL ingestion;
  - audio formats other than WAV;
  - a permanent microphone archive.
- **Current state needs new evidence.** No stored observation answers "what
  does it look like now". That takes a fresh upload or re-observation.
- **Deletion boundary** is the SQLite file and object directory. Backups,
  downloaded exports and anything a model already read are out of reach.
- **SQLite only.** The PostgreSQL backend has no asset tables.
- **Not connected to ChatGideon.** The app's upload paths and inspector page
  are unchanged. Wiring them in needs its own scope: which interpreter and
  provider, what it costs and how long it takes per modality, and where objects
  are stored.

## Disable or revert

Assets are off unless a host constructs a `SqliteAssetStore`, and each
modality stays off until consent is set. To remove the feature, revert the
commits above. Deleting the database file and object directory removes all
stored media.

This was the last optional stage. Any further work depends on the evidence
and the deployment scope that is chosen.
