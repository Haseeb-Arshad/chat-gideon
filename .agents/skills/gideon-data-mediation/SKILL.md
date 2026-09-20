---
name: gideon-data-mediation
description: Capture and validate source tables for GIDEON research visualizations while preserving cell evidence, units and missing values.
---

Read `docs/visualizations/02-data-and-mediation.md`. Use the runtime table mediation module rather than allowing a model to supply chart values. The researcher selects a captured table and columns; code copies the source cells.

Keep raw strings, source URL, retrieval time and source row positions. Reject ambiguous number formats, inconsistent units, duplicate category identities or heatmap pairs, and unsupported date precision for plotting. Repeated scatter x values and repeated distribution observations are valid; preserve their pairing and frequency. Missing values remain missing. Bound table counts, rows, columns and bytes before parsing. Do not add provider calls for chart formatting.

Test with captured-format synthetic fixtures and mocked fetch. Changing an extraction format requires a fixture for that format and explicit source limitations. Never claim source extraction verifies the publisher's underlying data or comparability by itself.
