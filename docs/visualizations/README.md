# Research-card visualization plan

Written 19 September 2026. **Current implementation:** [22-family coverage and verification](06-broad-implementation.md). The proposal and earlier audits below are historical snapshots; the advanced implementation supersedes their missing-family lists.

The [20 September code audit](05-code-audit-2026-09-20.md) maps every catalog family to actual routing/rendering support, records repairs, and lists the remaining implementation gaps.

## Decision

Yes, richer visualization is a good fit for GIDEON: comparisons, trends and timelines often communicate more clearly on screen than in speech. Build it into the existing research cards, with an expanded detail view for exploration. Do not start with a separate business-intelligence application. Interpret “stats” here as statistical information in answer cards; a separate usage dashboard is outside this proposal.

The first priority is reliable coverage: when research contains suitable, verifiable data, a matching visual should appear. Adding exotic chart types before resolving that path would leave the original problem unsolved. Qualitative comparisons should still appear as tables or timelines; do not invent numerical scores to force a chart.

This folder is a documentation scaffold populated with the requested details, rather than empty application modules that imply working features.

## Read in order

1. [Categories and selection](01-categories.md): what to show, when, and what data it requires.
2. [Data and mediation](02-data-and-mediation.md): turn sourced tables into trustworthy visuals.
3. [Interaction and delivery](03-interaction-and-delivery.md): presentation, implementation phases and economical verification.

## Current code evidence

The user reports missing graphs in their experience. Repository inspection establishes capability, not successful live delivery or the cause of that symptom.

| Existing location | Observed responsibility | Implication |
| --- | --- | --- |
| `src/lib/cards/schema.ts` | Chart forms: line, area, column, bar, range; also table and timeline blocks | Extend typed blocks rather than introduce a second card format |
| `src/components/stage/blocks/Chart.tsx` | SVG charts, summaries, pointer/keyboard readouts, table toggle | Preserve and improve this renderer |
| `src/components/stage/CardFace.tsx` | Dispatches chart and timeline blocks | New types must reach this dispatch path |
| `src/lib/cards/read.ts` | Validates chart structure and caps series/points | New contracts need validation and explicit limit handling |
| `src/lib/cards/from-materials.ts` | Builds trend/comparison cards from structured materials | Make generalized sourced datasets usable here |
| `src/lib/tools/desk/world-bank.ts` | Retrieves structured annual indicator series | Existing positive example; not general web-table extraction |
| `src/lib/tools/registry.ts` | Research materials become cards; legacy card builder is a fallback | Trace selection and fallback before diagnosing missing charts |
| `src/routes/lab.cards.tsx` | Existing card laboratory | Extend for offline display verification |
| `CARD_SYSTEM.md` | Earlier broad card-system plan | This proposal specializes its visualization work; does not replace it |

No charting library is currently declared in `package.json`. Keep the existing SVG path for the first phase. Evaluate additional rendering dependencies only against a concrete advanced type, accessibility, license and measured bundle cost.

## Reference reading

These references inform the proposal, not claims that GIDEON implements their features:

- [Tableau: choose the right chart](https://help.tableau.com/current/pro/desktop/en-us/what_chart_example.htm): match the analytical question to the visual.
- [Power BI: visual interaction](https://learn.microsoft.com/en-us/power-bi/explore-reports/end-user-visualizations): useful interaction patterns for an expanded card.
- [Datawrapper: chart selection guide](https://www.datawrapper.de/blog/chart-types-guide): editorial chart selection.
- [Datawrapper: charts inside tables](https://www.datawrapper.de/academy/how-to-add-bar-charts-line-charts-to-tables): compact comparisons and trends.
- [Reuters: making a chart](https://reuters-graphics.github.io/newsroom-datawrapper-guide/getting-started/making-your-first-chart/): newsroom workflow reference.

The catalog and engineering budgets below are our proposed product decisions, not vendor specifications.
