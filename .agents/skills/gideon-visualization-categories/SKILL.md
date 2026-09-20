---
name: gideon-visualization-categories
description: Implement or extend GIDEON research-card visualizations, including rankings, trends, timelines, scatter plots, distributions and heatmaps. Use for visualization categories, not general page styling.
---

Read `docs/visualizations/01-categories.md` for the requested family only. Runtime skills live in `src/lib/cards/visualization-skills.ts`; Markdown skills guide development and are not runtime prompts.

Extend existing materials, card blocks and renderers. Make eligibility depend on typed data, not the word "compare" alone. Preserve a sourced table when units, dates or numerical parsing cannot support a chart. Never manufacture numerical scores from qualitative fields.

For each enabled family, cover a valid example, a misleading-input rejection and card-reader round-trip in local tests. Do not advertise planned families as supported. Use the existing card laboratory for display checks; live provider benchmarks are unnecessary for selection logic.

Scatter points require paired numeric columns, not index-based x positions. Histograms require observations and explicit bin semantics. Heatmaps require a unique pair of categorical keys per value; leave absent pairs null. Never route these families through the trend description or infer causation from plotted association.
