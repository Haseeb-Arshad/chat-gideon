# Implementation: categories, mediation and tracking

## Implemented

Three repository development skills live under `.agents/skills/`: `gideon-visualization-categories`, `gideon-data-mediation`, and `gideon-visualization-tracking`. They describe how to extend and test this system. GIDEON's runtime behavior is implemented separately in TypeScript; the speaking agent is not expected to read these Markdown files.

Runtime category skills: ranking, comparison, trend, range, timeline, exact table, scatter, distribution and heatmap. The research desk sees their eligibility rules in `visualize_table`. It selects a captured table ID and column indexes (including a group column for heatmaps and an upper-bound column for ranges); it cannot send arbitrary chart values. The speaking-agent routing description directs chart requests to research rather than image search.

The page-reading path captures bounded Markdown pipe tables. Mediation retains raw source cells, source URL, retrieval time and source-line locators. Numerical parsing is deliberately conservative: ambiguous comma formats, scale words and footnotes remain in a table. Differing units, explicit period/cohort differences, duplicate categories and malformed dates also fall back to a sourced table with an explanation.

Cards reuse the existing renderer and schema. Rankings sort bars; comparisons use columns; trends sort dates and preserve actual time spacing; timelines order events. Source tables remain available and validated numeric columns can be sorted without another request. Touch readouts and exact numerical inspection are supported. Tiny non-zero numbers no longer display as zero solely because a compact label requested too few decimal places.

Scatter plots preserve paired numeric observations, including repeated x values, without connecting lines or implying causation. Distributions produce at most eight equal-width histogram bins from at least three complete observations; the last bin includes its upper endpoint. Aggregate summary columns are rejected as observation inputs. Heatmaps pivot one measure across two categorical columns, preserve missing cells separately from zero, and expose exact values through readable labels and keyboard/touch selection.

Tracking consists of bounded capture/selection records in the research result: stage, category, outcome, reason and row count. No source text, URL or cell values are included. These records also survive a successful hedge answer. They diagnose selection; they do not claim browser rendering or send external analytics.

## Verification

- Category and mediation fixtures exercise source preservation, numeric/unit rejection, fallback, ranking order, comparisons, time geometry, timelines and table preservation.
- A mocked research-loop test covers search → read → visualize → brief, including capture/selection diagnostics and provider-call counts.
- Browser inspection of synthetic lab cards confirms actual SVG rendering and chart bounds at 320, 375, 768 and 1440px widths. Mobile ranking and irregular-date trend layouts were inspected visually.
- The second increment adds local fixtures for scatter, histograms and sparse heatmaps. Desktop scatter/histogram and 375px heatmap layouts were inspected visually; selecting a missing heatmap cell reports no value. Focused analytical, renderer and chart-math checks passed (43 tests).
- The final full offline suite passed with two workers: 73 files and 756 tests. An earlier unrestricted parallel run had transport timing failures; the lower-concurrency runs passed without changing transport code.
- Type checking and the complete client/server/realtime production build passed after the second increment. The build retains the existing large-client-chunk warning. This work adds no charting dependency.
- No paid research/model benchmark or live research question was run. Local tests use synthetic inputs and mocked provider responses. Browser verification is local fixture proof, not live-source or deployment proof.

## Limits and next increments

The [20 September code audit](05-code-audit-2026-09-20.md) maps all 22 proposed families against the code. Its continuation adds validated source-table ranges, local date filtering/reset for dated line/area charts, and expanded chart details with sources and the original captured table. It also fixes signed rankings, exact range inspection, touch persistence, mobile lab overflow and provider-year spacing. The complete catalog remains unfinished; the September 19 test counts above describe that earlier implementation.

This is the first implementation, not the entire visualization catalog. Web-table capture currently accepts intact Markdown pipe tables from the existing reader. Arbitrary HTML tables, CSV uploads, OCR, locale inference and multiple-table joins are not implemented. Source extraction does not establish the publisher's accuracy; the researcher must still inspect definitions and footnotes. A source whose reader output has no usable table continues through the existing answer-card fallback.

One selected dataset is supported per research answer. Scatter accepts two numeric measures; heatmaps accept two categorical dimensions and one measure. Table capture caps are 100 KB text, four tables per page, eight per research run, 50 rows and eight columns. Ranking allows 15 rows, comparison 24, timeline 16, scatter 50 paired observations, and heatmaps 12 columns by eight groups within the source-row cap. Category display limits fall back rather than silently discard rows. Timeline dates currently accept full ISO dates or four-digit years; mixed precision is rejected.

The visualization tool makes no network call itself. Selecting it can consume a round within the existing bounded research-model loop; this is not a claim that all production chart answers cost zero model tokens. Rendering, sorting, touch inspection and chart/table switching require no model call.

Run `npm run dev:visualizations`, then open `http://localhost:3012/lab/cards?visualizations=1` for the synthetic fixture page. The dedicated process disables PostHog with a placeholder token that the existing provider explicitly skips. This avoids an empty environment variable being repopulated from `.env` on Windows. Saved analytics configuration is unchanged. Ordinary dev mode can still run the app's existing analytics.

Next independent increments: grouped multi-measure datasets; before/after and stacked comparisons; small multiples; specialized geographic/flow/hierarchy views. Each requires its own schema, renderer, routing eligibility and local acceptance fixtures before runtime enablement. Expanded linked filtering and editorial narrative sequences remain planned.
