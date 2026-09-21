# Stage 16: Portable framework, SQLite, SDK, MCP, and second integration

## Agent prompt

Implement this stage in the actual repository. Read [common instructions](00-COMMON-INSTRUCTIONS.md), the [foundation](../FOUNDATION-2026-09-21.md), the [progress ledger](00-PROGRESS.md), and the prerequisite handoffs. Inspect current code before editing. Complete implementation and verification, not another plan. Preserve unrelated work and stop after this stage.

## Objective

Extract a usable independent memory framework whose adapters preserve the proven semantics.

## Prerequisites and entry gate

- Completed [stage 15](15-migration-and-rollout.md) and its handoff, including the actual interfaces/tests it established.


For stage 15, a passed local cutover rehearsal is sufficient here. Do not block packaging on an unauthorized public deployment.

If a prerequisite is absent, first determine whether an equivalent implementation exists. Repair a small directly blocking prerequisite with tests and document it; do not silently implement several missing stages or assert they passed. Finish independent work and report the exact unresolved dependency.

## Read and inspect

Stable implementation map/contracts, PostgreSQL conformance suite, migration handoff and actual ChatGideon coupling points.

## Implementation steps

1. Audit the core for ChatGideon UI, identity provider, Cloudflare, filesystem, database-driver and model-provider assumptions. Define host-supplied interfaces without weakening authorization or transaction semantics.

2. Move/package the proven code into a minimal core, SDK and backend structure with compatibility shims for ChatGideon. Avoid a package for every function; preserve builds and imports throughout.

3. Version wire protocol, stored schema and export semantics separately. Publish capability descriptions for transaction, temporal, suppression, leasing and identity behavior; unsupported guarantees fail explicitly.

4. Implement SQLite transactions, foreign keys, version checks, job leasing and lexical search behind the same backend contract. Coordinate multiple processes through database locking, not a process-local Promise queue.

5. Run the same backend conformance suite against PostgreSQL and SQLite. Test concurrent writers, idempotency, deletion/source suppression, restart, export/import and clock/lease behavior.

6. Add a local server/worker mode and TypeScript SDK with cancellation, pagination, typed errors and scoped session construction. Explicit remember/correct/forget must work without a model or embeddings.

7. Implement MCP recall/get/remember/correct/forget/resume/explain surfaces with identity/grants bound to the connection. Models cannot pass arbitrary tenant identities; large histories require separate bounded reads.

8. Use secure defaults for local filesystem permissions and remote authentication. Do not treat stdio or a random filename as a universal security boundary. Keep credentials outside exports and examples.

9. Build a second synthetic host integration outside ChatGideon. If using the portfolio, inspect its actual current code and introduce verified visitor sessions; published owner knowledge must remain separate. Public deployment is a separate scoped action.

10. Demonstrate opt-in sharing through explicit grants and verified linking where implemented. If linking is not implemented, keep scopes isolated and document the limitation instead of joining by email/name.

11. Ship installation, quickstart, version compatibility, backend capability matrix, conformance instructions and deletion/export limits. Include a minimal real example that survives a process restart.

12. Prepare release artifacts and license/dependency review; do not publish packages or private fixtures without explicit user direction. Keep the application functional after extraction.

## Verification and acceptance scenarios

Relevant seed IDs: **C04, C05, C19, C20, C21, C22, C23, C24, C25, C29, C33** from [acceptance scenarios](../acceptance-scenarios.json).

Run cross-backend contract tests with independent processes and a fresh-install example. Verify MCP tool arguments cannot change identity. Re-run ChatGideon transport/build checks after package extraction.

Inspect both positive and forbidden outcomes. Map case IDs to executable test names and evidence in the handoff. Pure mocks may verify control flow but cannot prove database, provider, deployment or actual voice behavior. Missing capabilities are reported explicitly.

## Required deliverables

Portable packages/server/SDK, SQLite backend, MCP adapter, second-host example, conformance matrix and release-ready documentation.

Also update implementation-map.md and [00-PROGRESS.md](00-PROGRESS.md). Write `handoffs/16-independent-framework.md` using the [handoff template](00-HANDOFF-TEMPLATE.md). Include actual commands, scope, results, limitations and how to disable/revert safely.

## Exit gate

The framework can be used without ChatGideon and both backends uphold their declared guarantees. Requires passed local cutover rehearsal, not an unrequested public production launch.

## Scope boundary

No universal adapter claims, automatic cross-app sharing, or replacing native semantics with get/set wrappers.

Do not start the next numbered stage. Do not deploy, publish, provision paid infrastructure or migrate customer production merely because this prompt exists. Follow any explicit environment/action authorization already given by the user without requesting it again.

## Final response to the user

State implemented behavior, changed paths, local/staging/live verification, unresolved gates and the handoff path. Identify [stage 17](17-procedural-learning.md) as the next prompt only if the user chooses the optional procedural track; stage 18 is independently optional.
