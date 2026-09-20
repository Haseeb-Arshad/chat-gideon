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

In progress. No family is considered complete solely because it is named in a union or tool definition.
