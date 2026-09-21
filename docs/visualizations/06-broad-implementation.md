# Broad visualization implementation

User brief: implement broad, high-quality coverage across all 22 families in the visualization catalog, including the advanced graphs and interactions, using the existing GIDEON card system.

## Acceptance

- Every family has a source-backed selection path and a rendered representation, with an exact table and source access.
- Implement comparisons, composition, uncertainty, distributions, relationships, calendar/time/duration, geography, hierarchy, flow, contribution, targets, small multiples and sourced editorial views without invented values.
- Dataset inspection, compatible view switching, visibility, filtering, reset and exports operate locally on captured data.
- Preserve stable identities, units, missingness, retrieval time, source locators and deterministic transformation descriptions.
- Invalid or insufficient evidence produces an explained source-table fallback. A broad catalog is not a promise that every chart is valid for every dataset.
- Verify valid, invalid and reader-round-trip cases per family, renderer interaction/accessibility tests, the offline suite, typecheck and build. Report local proof separately from live providers and deployment.

## Work sequence

1. Extend existing chart/table contracts and deterministic mediation.
2. Implement and test advanced SVG/HTML renderers and source tables.
3. Add shared exploration, multiple selected visuals and broader structured capture.
4. Build the complete synthetic family gallery, verify integration, and publish a final code coverage matrix here.

## Implemented family coverage

All 22 catalog families have a deterministic source-selection path and a rendered representation. This covers the following forms, not every conceivable variant within each family.

| Family | Implemented representation and contract |
| --- | --- |
| KPI | Statistic with optional sourced baseline and disclosed absolute delta |
| Ranking | Zero-based horizontal bars and ranked dots |
| Comparison | Columns and grouped columns with comparable units |
| Trend | Lines, areas, true date spacing and missing-value gaps |
| Interval | Low/high ranges and validated lower/estimate/upper bands |
| Before/after | Slope and dumbbell views of paired endpoints |
| Composition | Stacked and percentage-stacked bars reconciled to sourced totals |
| Share | Donut and approximate 100-cell waffle with exact table values |
| Distribution | Equal-width histogram and grouped boxplots with sample sizes/outliers |
| Relationship | Paired scatter and area-scaled bubbles |
| Matrix | Heatmap with explicit missing cells and numeric intensity legend |
| Calendar | Daily heatmap, missing-day expansion and timezone disclosure |
| Event sequence | Timeline and proportionally spaced dated events |
| Duration | Gantt intervals; ongoing intervals require a sourced as-of date |
| Geography | Published latitude/longitude symbol map; no inferred boundaries |
| Hierarchy | Acyclic additive treemap with explicit parent/child identities |
| Flow | Conserved acyclic Sankey and same-cohort/period funnel |
| Contribution | Reconciled signed waterfall |
| Target | Actual/target bullet chart; no fabricated success zones |
| Small multiples | Two to five comparable trends on shared scales |
| Rich table | Exact cells with per-column inline bars, sort/filter/pagination |
| Editorial | Sourced annotations, previous/next navigation and linked selected values |

There are 35 runtime selection modes, 29 chart forms and 40 synthetic gallery examples. Use `npm run dev:visualizations`, then `/lab/cards?visualizations=1`. The example picker makes every example directly accessible. The lab disables analytics and its development console bridge; no paid research is needed.

## Shared exploration and delivery

- Compatible form switching, category search, date selection and reset run locally. Composition, flow and hierarchy are never partially filtered into misleading wholes.
- Line/grouped-column visibility retains palette positions and full table values; at least one measure stays visible.
- Pointer/touch and keyboard inspection, exact chart tables, expanded modal views, original source tables and source links are available.
- Source tables support text search, numeric sorting, 50-row pages, full CSV/JSON export, row/column locators and a methodology inspector. JSON exports preserve raw cells; CSV protects spreadsheet formula prefixes.
- Research retains up to four distinct selections, including multiple views of one dataset. A fifth is explicitly refused; replacing selections requires an explicit tool flag. Combined cards retain unique block IDs and correct per-view source-table/citation associations.
- Provider-series comparisons group by measure and unit and disclose any series outside the five-series chart limit.

## Verification and boundaries

Valid examples, invalid-role and misleading-input cases, reader round-trips, renderer geometry/keyboard checks, chart switching/filter/reset and mocked research retention are covered by offline tests. The final verification numbers are recorded below when checks finish.

Browser checks: all 40 examples render at 320px and 1440px without page overflow or invalid SVG coordinates. Expanded flow and boxplot views were inspected; keyboard inspection returned exact quartiles, sample size and outlier values. Original source tables remain available in the modal. One browser-extension hydration warning triggered a development-console feedback loop; the isolated visualization mode now omits that console bridge.

These are local/synthetic and code verification results, not live-provider or deployment proof. No production deployment was requested. The source must actually contain eligible data; numerical plausibility does not prove publisher accuracy. Choropleth boundaries, OCR, automatic joins, arbitrary nested JSON, dependency inference, interactive geographic zoom, and table sparklines are not claimed. Category-specific readability limits intentionally produce explained table fallbacks rather than discard source rows.

First increment: 26 advanced selection modes and 21 advanced chart forms added to the existing renderer, with 26 source fixtures. Offline suite: 75 files / 881 tests; production build and TypeScript passed. Committed as `56d209a` and pushed.

Structured capture now accepts Markdown pipe tables, quoted CSV, TSV and flat JSON object arrays within 100 KB, 400 rows and 16 columns. JSON retains numeric lexemes and actual object-start line numbers; record IDs distinguish objects sharing a minified line. Nested JSON, malformed quotes, duplicate headers/keys and excess sizes are refused. HTML tables, OCR and automatic joins remain unsupported. Explicit numeric locale selection supports en-US, de-DE and fr-FR; magnitude conversions are disclosed and conflicting scales refused.
