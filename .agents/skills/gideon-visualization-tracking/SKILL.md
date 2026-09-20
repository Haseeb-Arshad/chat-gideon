---
name: gideon-visualization-tracking
description: Diagnose GIDEON visualization selection and fallback outcomes, and verify chart interactions with bounded offline tests.
---

Read `docs/visualizations/03-interaction-and-delivery.md`. Track stage, skill, reason and counts locally in the research result; do not log raw source content, question text or sensitive cell values. Distinguish selection success from actual browser rendering and live deployment.

Keep interaction on the captured dataset with no provider request. Check keyboard, touch, chart/table parity, cancellation and late-card behavior using existing test infrastructure. Test each implemented category independently before the integrated suite. Report fixture, live and deployment results separately. Use no paid benchmark merely to verify layout.

For local browser checks, use `npm run dev:visualizations` and `/lab/cards?visualizations=1`. The dedicated process disables analytics and the filtered view renders only synthetic visualization fixtures. Prefer two Vitest workers on this machine; unrestricted parallelism has caused transport-test timing failures.
