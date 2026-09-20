# Data accuracy and the mediation layer

Status: design proposal; names below are conceptual contracts, not implemented exports.

## One evidence path

Research result / structured provider → bounded extraction → normalized dataset → evidence and comparability validation → visual selection → existing card blocks → renderer and source table.

Carry structured data alongside the brief. Do not reconstruct a complete dataset from the short spoken summary. Reuse existing materials and card contracts; extend them with a dataset variant if their current series/record forms cannot express the evidence.

## Proposed dataset contract

| Field | Purpose |
| --- | --- |
| Stable dataset ID and version | Keep selections, patches and citations attached to the right data |
| Typed columns | Stable key, display label, number/category/date type, unit, currency and scale multiplier |
| Rows with stable IDs | Raw source text plus normalized values; null plus missing reason, never automatic zero |
| Source references | Source URL/title, retrieval timestamp, publication date when known, table/row/column locator |
| Observation context | Period, timezone where relevant, geography, cohort, metric definition, denominator |
| Per-cell evidence links | Trace a plotted value to its actual source cell, not merely a page mentioning the same number |
| Transform log | Inputs, operation, parameters, output and rounding policy for every derived measure |
| Quality and coverage | Verified, ambiguous, incomplete or unavailable; omitted rows and conflicting sources |

Chart specification references column keys and dataset version, selected form, filters, sorting and approved transforms. A model may recommend these choices; deterministic code validates and computes them. Never execute model-supplied JavaScript, SQL, HTML or arbitrary chart specifications from a webpage.

## Extracting web tables

Prefer structured APIs and machine-readable tables. Read headers, footnotes, units and date context together. Handle multi-row headers, locale decimals, percent signs, thousands separators, currencies and scale words explicitly. Preserve the raw text so conversion is auditable.

Reject ambiguous parsing rather than guessing whether “1,234” is a decimal or a thousand-scale value. A dash can mean missing, suppressed or not applicable; it is not automatically zero. Keep provisional and estimated figures labelled. Table shape alone does not prove accuracy.

Search snippets and inaccessible page summaries generally lack enough context for a full chart. A screenshot/OCR-only table requires additional verification; otherwise present it as unavailable for reliable plotting. Do not read an entire large dataset when the question requires a small subset.

## Validation rules

- Verify finite numeric values, field types, unique identities, aligned lengths and supported date precision.
- Align time by real timestamps. The current renderer spaces x labels by index; irregular time data needs a time scale before it can be honestly shown as a time-distance plot.
- Do not join entities by display name alone. Resolve keys and aliases with explicit evidence.
- Do not silently compare different currencies, fiscal years, adjusted/unadjusted measures or populations.
- Keep conflicting source values separate with their context; do not average them to hide disagreement.
- Compute sums, ratios, changes and bins in code. Guard zero denominators; label percentage-point change distinctly from relative percent change.
- Preserve missing intervals. Do not interpolate, extrapolate or smooth into invented observations.
- Validate completeness before part-to-whole charts; validate pairings before scatter; validate reconciled components before waterfall.
- When a parser or renderer limit excludes rows or series, expose that omission and retain an accessible route to the relevant data.
- Generate visual summaries from the validated dataset and transforms, so speech, chart, readout and table agree.

## Interaction does not require fresh research

Sorting, filtering, changing a compatible chart form and showing the data table operate on the same cached dataset. A new metric, entity or period outside that dataset becomes an explicit research request. Cache by source, parameters and dataset version; use provider-appropriate freshness and display observation age separately from retrieval time.

Abort stale requests on cancellation or a superseding question. Validate a complete card before displaying it. A failed or late chart must not block speech, overwrite a newer card or leave an empty graph container.

## Diagnostic outcomes

Record bounded internal reason codes: no structured data, insufficient evidence, incompatible units, unsupported form, validation failure, card superseded, render failure. Keep scraped content and sensitive rows out of telemetry by default.

Show users a useful fallback: sourced table when exact data is valid, a statistic when there is only one observation, or a concise explanation when no reliable visual can be made. Distinguish a successful answer with no chartable data from a chart delivery failure.
