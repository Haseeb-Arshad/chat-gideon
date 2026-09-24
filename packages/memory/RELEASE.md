# Release notes and review: @gideon/memory 0.1.0

Not published. Nothing here has been pushed to a registry, and no private
fixture is included; the tests generate synthetic data. Publishing needs an
explicit decision from the repository owner.

## Contents

- `src/`: contract, core, text utilities, SQLite backend, PostgreSQL
  adapter, local server, SDK, MCP server.
- `bin/mcp-sqlite.ts`: stdio MCP entry point.
- `examples/visitor-notes/`: second host (no ChatGideon code).
- `test/`: cross-backend conformance, SQLite specifics (restart, quota,
  schema version, four-process writers), server/SDK, MCP (including a real
  stdio process), and the example as a separate process.

## Dependency review

| Dependency | Used by | License | Notes |
|---|---|---|---|
| `node:sqlite` | SQLite backend | Node.js (MIT) | built in; experimental in Node 22, which prints a warning |
| `node:http`, `node:crypto`, `node:readline` | server, SDK, MCP, example | Node.js (MIT) | built in |
| `pg` 8.23 | PostgreSQL adapter only | MIT | optional peer dependency |
| ChatGideon `backend/memory` and `src/lib/memory` | PostgreSQL adapter only | repository license | the adapter is a thin layer over them and cannot ship separately yet |
| `jiti` (dev) | running `.ts` entry points in tests and examples | MIT | not needed at runtime once compiled |

There are no other runtime dependencies. No telemetry, no network calls
except the server the host starts, and no credentials in examples. The
example reads its session secret from the environment.

## License

The repository has no license file, and the root package is private. This
package is marked `UNLICENSED` until the owner picks a license; do not
publish before that.

## Before a public release

1. Choose a license and add it.
2. Compile to JavaScript with `.d.ts` files. The sources use `.ts` import
   specifiers.
3. Split the PostgreSQL adapter so it depends on a published
   `backend/memory` rather than repository paths.
4. Wait for `node:sqlite` to leave experimental status, or accept the warning.
5. Run the conformance suite on every backend in CI.
