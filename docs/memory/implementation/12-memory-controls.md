# Stage 12: Inspector, user controls, corrections, forgetting, and export

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Give users understandable control over what is remembered, why, where it is used, and whether it has been forgotten.

## Prerequisites and entry gate

- Completed [stage 10](10-background-learning.md) and its handoff, including the actual interfaces/tests it established.



If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Existing ChatGideon visual language and action ledger; command, inspection, grant, deletion and projection APIs.

## Implementation steps

1. Create an authenticated inspector/read API with scoped pagination and compact evidence summaries. Debug metadata and source relationships are private too.

2. Build a curated overview of important preferences, active topics, decisions and proposed inferences. Avoid dumping thousands of raw rows as the default experience.

3. For each item show accepted text, explicit/inferred/legacy basis, scope, freshness, source where permitted, and current uncertainty/conflict. Legacy imports must not invent citations.

4. Implement versioned edit/correction using the existing command API, including stale-edit conflicts and contextual versus global changes. Show the accepted result, not an optimistic success that might fail.

5. Implement exact-target forget controls with clear scope and honest logical-block/purge statuses. Require clarification only for ambiguous targets; respect already authorized explicit deletion.

6. Expose learning on/off, temporary conversation mode, and retention choices with server-enforced effects. State whether a setting stops future capture, disables learning from existing evidence, or deletes existing content.

7. Add memory receipt states to the existing ledger and keep speech brief. The agent should apply preferences naturally rather than routinely narrating its profile.

8. Implement versioned authorized JSON export plus a readable Markdown projection and manifest. Include permitted sources, version/time semantics and known provenance gaps.

9. Implement controlled import with base-version checks, path/ID validation, payload bounds and attributable import events. Reject traversal and symlink escape; stale exports cannot resurrect suppressed content.

10. Keep cross-application sharing opt-in and out of this stage unless an existing verified linking flow already exists. Do not infer cross-device identity from a name, IP or analytics ID.

11. Test UI accessibility, empty/loading/failed/conflicting states and privacy across two synthetic users. Verify changes in the next actual conversational turn.

12. Document the difference between managed deletion and uncontrolled exported copies. Keep detailed raw debug traces opt-in and short-lived.

## Verification and acceptance scenarios

Relevant seed IDs: **C04, C05, C06, C19, C22, C24, C25, C31** from [acceptance scenarios](../acceptance-scenarios.json).

End-to-end inspect → edit → recall → forget → recall, including stale open tabs, failed writes, unauthorized item IDs and an export/import after deletion. Verify temporary sessions do not create durable evidence.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Memory controls UI/API, source inspection, versioned edits, deletion status, retention/learning settings, export/import and browser verification evidence.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/12-memory-controls.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

User-visible receipts reflect canonical state; one user cannot inspect another's metadata; controls change actual runtime behavior, not only UI labels.

## Scope boundary

Do not redesign unrelated cards/pages or turn visitor memory into public portfolio owner knowledge.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 13](13-comparative-evaluation.md) as the next prompt.
