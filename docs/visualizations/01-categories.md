# Visualization categories and selection

Status: proposed behavior. P1 means first coverage release; P2 means expanded analysis; P3 means specialized, demand-driven work. An existing renderer does not establish end-to-end routing coverage.

| Category / forms | When it belongs in a card | Required evidence and safeguards | Delivery |
| --- | --- | --- | --- |
| Single statistic / KPI with delta | One meaningful measure, such as current population | Unit, period, source; delta requires comparable baseline; no invented sparkline | P1; reuse stat blocks |
| Ranking / horizontal bars, dots | Largest, smallest, fastest or ordered category comparison | Same metric, unit and period; bars start at zero; disclose top-N omissions | P1 bars; P2 dots |
| Category comparison / columns, grouped bars | Compare a few entities or subgroups | Comparable units and definitions; avoid a different scale per entity | P1 columns; P2 grouped bars |
| Trend / line, area | Movement over ordered time | Real dates and intervals; missing observations are gaps; area uses zero baseline | P1; existing forms |
| Interval / range or uncertainty band | Low-high temperatures, estimates with bounds | Label what bounds mean; confidence intervals require published level/method | P1 range; P2 bands |
| Before-after / slope, dumbbell | Two comparable observations for each entity | Same endpoints and definitions; distinguish absolute change from percent change | P2 |
| Composition / stacked bars, 100% bars | Parts of a known whole across categories | Mutually exclusive components, stated denominator and remainder; do not normalize unknown totals | P2 |
| Simple share / donut, waffle | A small number of parts of one whole | Prefer a bar for precise comparison; no negative parts or hidden remainder | P3, optional |
| Distribution / histogram, box plot | Spread, skew or outliers, such as response-time distribution | Observations or verified quantiles; declared bins and sample size; averages cannot imply a distribution | P2 |
| Relationship / scatter, bubble | Whether two numeric measures vary together | Paired observations, units and identities; correlation is not causation; bubble area encodes size | P2 scatter; P3 bubble |
| Matrix / heatmap | Intensity across two dimensions, such as weekday by hour | Explicit scale, missing-cell style, accessible values; distinguish zero from absent | P2 |
| Calendar heatmap | Daily activity over months | Date, timezone, period completeness; avoid implying missing days are zero | P2 |
| Event timeline / annotated sequence | What happened when, or a historical comparison | Sourced events and date precision; approximate dates labelled; no invented duration | P1 existing timeline; P2 scaled view |
| Duration / Gantt | Overlapping projects, terms or processes | Start/end dates, open-ended status and dependencies if actually known | P3 |
| Geographic / symbol or choropleth map | Location is essential to the question | Verified geography; use rates for regional choropleths when totals would mislead; disclose boundaries | P3; reuse map architecture |
| Hierarchy / treemap | Part-to-whole across nested categories | Valid parent-child relationships and additive values; bars remain available | P3 |
| Flow / Sankey, funnel | Transfers between entities or conversion through stages | Actual edge/stage counts, consistent cohorts and period; do not infer flows from independent totals | P3 |
| Contribution / waterfall | How additions and deductions explain a total | Reconciled start, signed components and end; explicitly identify any residual | P2 |
| Target / bullet chart | Actual against an explicit target | Sourced target and comparable actual; no arbitrary success zones | P2 |
| Small multiples | Compare many comparable trends without overlapping lines | Shared axes by default, common periods and units; explicit exceptions | P2 |
| Rich comparison table / inline bars, sparklines | Mixed attributes or precise lookup plus a visual cue | Preserve exact cells; visualize only comparable numerical columns | P1 table; P2 inline marks |
| Editorial explainer / annotations and linked panels | Explain a finding through a sequence of views | Every annotation grounded; visible methodology; browsing the story must not change the underlying evidence | P2 basic annotations; P3 narrative sequences |

## Selection order

1. Identify the question: value, ranking, change, composition, relationship, distribution, location or event sequence.
2. Inspect available fields and evidence, not keywords alone. “Compare” can mean qualitative specifications, numeric ranking or parallel trends.
3. Check comparability: metric, unit, currency, period, geography, cohort and denominator.
4. Honor an explicit requested chart only when compatible. Otherwise explain the mismatch and show the closest honest table or visual.
5. Select the simplest suitable form and the smallest readable card. One primary visual per standard card; additional views live in expanded details.
6. Show units, observation date, sources, a factual summary and a table alternative. Do not add a chart if data cannot support one.

## Example outcomes

- “Compare these countries' GDP over time”: aligned line series, stating current/constant currency basis and missing years.
- “Compare these laptops”: mixed specification table; a price bar only when currency, date and configuration match.
- “What happened during the launch?”: event timeline, not arbitrary numeric progress bars.
- “How did spending reach this total?”: waterfall only if components reconcile.
- “Show latency distribution”: histogram only from observations or known bins; a lone average stays a statistic.
- “Compare popularity”: seek a defined measure; if no evidence establishes one, show sourced qualitative information and explain the limitation.

Avoid default 3D charts, decorative gauges, dual axes and animation that continually rearranges rankings. They add visual complexity without resolving the core research-card problem.
