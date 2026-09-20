# Interaction, implementation and economical verification

Status: proposed work sequence. None of these acceptance checks have been run as part of this documentation change.

## Presentation

Keep the current card stage and glass treatment. A card should contain a clear question-specific title, prominent visual, units/period, one factual takeaway, and source access. Put dense exploration in an expanded view. Small cards should show a statistic or compact trend rather than squeeze a dashboard into a glance.

Standard controls: chart/table toggle, keyboard and touch value inspection, source details and expand. Later: sort, series visibility, date-range selection and filters when supported by the dataset. Show active filters and a reset action. Chart changes should preserve units, selected period and provenance.

BI-style linked filtering belongs only in expanded multi-panel views: selecting a category updates related panels sharing the same dataset and clearly states the selection. It must not silently filter unrelated research cards.

Editorial details: direct labels where readable, restrained color, grounded event annotations and optional small multiples. Narrative sequences remain user-controlled. No autoplay or mandatory scroll animation. Preserve the existing spoken-fact highlighting without moving focus or fetching data on each voice update.

Every visual needs a text summary and accessible table. Provide visible keyboard focus, non-color distinctions, sufficient contrast and reduced-motion support. Tooltips cannot be the sole access to values. Touch inspection must be implemented deliberately; the current chart hover handler skips touch pointers.

At 320/375/768/1440px viewport widths, labels must remain legible and card controls reachable. Use internal table scrolling where necessary, with row headers retained; avoid page-wide horizontal overflow. Long titles, negative values, large magnitudes, nulls and all-zero series need explicit layouts.

## Work sequence and exit criteria

### 1. Reproduce missing chart coverage offline

Trace representative questions through research materials, `cardFromMaterials`, fallback generation, validation, `CardFace` and the stage. Add a bounded diagnostic reason at each failure boundary. Establish whether the reported issue is missing data, selection, validation or display before claiming a root cause.

Exit: known structured series reliably create and display a chart in the existing card laboratory; non-chartable results have a deliberate fallback.

### 2. Generalize sourced table support

Extend materials with the minimal typed dataset/provenance contract; normalize and validate extracted tables. Add deterministic selection for numeric rankings, comparisons and trends. Preserve older card parsing and patches.

Likely code surfaces: `materials.ts`, `from-materials.ts`, `read.ts`, `schema.ts`, research adapters and registry under their existing directories. Decide exact new modules only after the trace in phase 1.

Exit: a sourced numeric table becomes the correct chart with identical numbers in table, readout and summary; ambiguous and incompatible data do not become misleading graphs.

### 3. Make current visuals consistently usable

Improve touch inspection, irregular-time scales, visible limit disclosures and expanded layout. Keep current SVG rendering and palette. Extend existing card tests and lab fixtures.

Exit: keyboard, touch, mobile, missing-data and source-access checks pass without additional network calls during interaction.

### 4. Add analytical families incrementally

Implement P2 types in small groups: before-after and composition; distributions and scatter; heatmaps and small multiples; then target/contribution views. Each type needs a validated contract, selection rules, renderer, accessible table and relevant tests before enabling runtime selection.

Exit per type: real required inputs are enforced, unsupported inputs fall back safely, and the view fits card/expanded layouts.

### 5. Add advanced exploration only where justified

P3 maps, hierarchies, flows and narrative sequences follow actual user demand. Evaluate any dependency with a representative prototype; lazy-load heavy renderers. Do not make basic stats download a full BI engine.

## Low-data and low-cost policy

Interpret “data consumption” as network bytes, provider requests and model tokens. Measure them separately. The following are proposed initial caps, not measured current behavior:

| Activity | Initial policy |
| --- | --- |
| Documentation work | No live agent calls or paid benchmarks |
| Routine functional checks | Synthetic/local fixtures, mocked external adapters, zero provider calls |
| Chart/table/sort/filter interaction | Zero network requests; reuse the dataset |
| Normal rendering | Zero additional model calls solely to draw a chart |
| Dataset sent to a card | Target at most 100 KB uncompressed serialized data; reject or explicitly summarize excess |
| Existing chart limits | Preserve current validator limits initially: line 5×400, area 1×400, column 3×24, bar 1×15, range 2×31 |
| Advanced charts | Specify per-type mark caps before enabling them; no unbounded DOM/SVG |
| Optional live smoke check | One representative question, at most two external requests in total, no retries, concurrency one, 1 MB response-byte cap, and 2,000 total model input/output tokens if a model is unavoidable |

The smoke-check harness must actually enforce these limits, including streamed byte limits and model input size. If the existing agent cannot be bounded, test a single adapter under a capped harness; do not call that an end-to-end test. Reuse an existing provider response where possible. Do not run broad benchmark scripts merely to check styling.

A richer answer requiring more evidence should use a separate explicit deep-research path. No repeated search loop to obtain a visually pleasing dataset. Sampling or aggregation must be visible and preserve the full-data meaning; never silently discard outliers.

## Acceptance matrix

| Check | Evidence needed |
| --- | --- |
| Correct selection | Fixtures for ranking, trend, qualitative comparison, timeline and insufficient data |
| Numeric integrity | Raw cells → normalized values → transforms → plotted/table values remain traceable |
| Invalid input | Conflicting periods, currencies, malformed numeric text, nulls and duplicate identities handled honestly |
| Responsiveness | Local rendered checks at the four viewport widths; no clipped controls or unreadable axes |
| Accessibility | Keyboard and touch access, summary/table parity, contrast and reduced-motion checks |
| Runtime flow | Chart delivered to the correct active card; cancellation and late patches cannot replace a newer answer |
| Efficiency | Request counter stays at zero during interaction; payload and mark limits enforced |
| Compatibility | Existing chart, parsing, material and card tests remain valid |
| Optional live proof | Actual sourced result shown in a card under enforced smoke-test caps, reported separately from fixture success |

For implementation, run focused tests first, then required type/build checks once the change is integrated. Report local fixtures, live-provider proof and deployment separately. This proposal does not authorize claiming any of those outcomes from document review alone.
