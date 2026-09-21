# Stage 18: Optional multimodal memory with modality-specific consent

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Add authorized image/document/audio-derived memory without confusing old observations, generated descriptions and current reality.

## Prerequisites and entry gate

- Completed [stage 16](16-independent-framework.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Artifact ID/display contracts, evidence/deletion infrastructure, export policy and current upload/media interfaces.

## Implementation steps

1. Specify supported modalities and consent separately for raw assets, transcripts/descriptions, embeddings and retention. Enabling text memory does not automatically authorize raw audio/image retention.

2. Store asset IDs, immutable revisions, owner/scope, content type, bounded size, source timestamp and provenance in the canonical envelope; use protected object storage only when appropriate.

3. Validate uploads and parsing boundaries, enforce content/size limits, and prevent external URL references from becoming arbitrary network-fetch permissions.

4. Extract descriptions/OCR/transcripts as derived evidence with producer/version, source region or time span and uncertainty. A model description is not equivalent to the original asset.

5. Connect artifact display snapshots and referents to conversational state. Preserve which revision the user selected or discussed.

6. Implement retrieval over accepted derived descriptions plus authorized source fetch. Keep unsupported visual conclusions as uncertainty rather than invented personal facts.

7. Distinguish historical observation from current state. An old room image can inform a past discussion; it cannot establish what the room looks like today without new evidence.

8. Propagate correction/deletion through raw assets, thumbnails, transcripts, captions, embeddings, profiles and exports. Prevent stale parsing jobs from recreating deleted derivatives.

9. Add modality-specific budget, latency and provider-outage behavior. Fall back to text-only memory honestly rather than claiming visual recall.

10. Evaluate held-out image/document reference tasks, stale-scene questions, interrupted audio and negative personalization. Include real media fixtures with redistribution permission, not private user assets.

11. Document supported formats, unsupported cases, retention/deletion limits and what requires a fresh upload or re-observation.

## Verification and acceptance scenarios

Relevant seed IDs: **C01, C16, C17, C22, C24, C35** from [acceptance scenarios](../acceptance-scenarios.json).

Verify cross-user asset denial, stale asset revisions, source-region lineage, deletion during parsing, export permissions and uncertainty when the source is missing. Compare text-only and multimodal paths under matched tasks.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Consented asset/derived-memory pipeline, multimodal retrieval adapter, deletion conformance, inspector support and measured evaluation.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/18-multimodal-memory.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

All retained modalities are authorized, attributable and deletable within declared boundaries; stale observations are never silently presented as current facts.

## Scope boundary

Optional stage: no permanent raw microphone archive, face/voice identity linking by inference, or hidden sensitive-trait extraction.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. State that this is the last optional stage; remaining work is whatever the evidence and chosen deployment scope actually require.
