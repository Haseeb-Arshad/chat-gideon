import { ADVANCED_SKILLS } from './advanced-mediation'

const advancedNeeds: Record<typeof ADVANCED_SKILLS[number], string> = {
  statistic: 'A numeric measure; one source row or an explicit row_index. Optional baseline_column gives an absolute delta.',
  'dot-ranking': 'Unique category labels and one comparable measure.',
  grouped: 'Two or three comparable value_columns including value_column; unique categories.',
  'multi-trend': 'Two to five comparable value_columns over unique source dates or years.',
  area: 'One measure over unique dates or years; a zero baseline is enforced.',
  uncertainty: 'Dates plus lower_column, value_column for the estimate, upper_column and a source-defined bounds_label; paired bounds must contain the estimate.',
  'before-after': 'Unique entities, value_column before and after_column after, with comparable source-defined endpoints.',
  slope: 'Same requirements as before-after; use a slope view.',
  composition: 'Mutually exclusive value_columns, parts_exclusive=true only if the source establishes exclusivity, and total_column for each sourced whole. Parts must reconcile.',
  'composition-percent': 'Same requirements as composition; percentages computed against each verified total.',
  share: 'Category parts and a repeated sourced whole in total_column; parts_exclusive=true, nonnegative parts must sum to the whole.',
  waffle: 'Same requirements as share; shows 100 approximate share cells with exact values retained.',
  boxplot: 'Individual observations in value_column, grouped by label_column, at least three per group. Not averages or precomputed quantiles.',
  bubble: 'Numeric label_column for x, value_column for y, size_column for nonnegative symbol area.',
  calendar: 'Unique full ISO dates and a numeric measure; optional constant timezone_column. Missing days remain absent.',
  'scaled-timeline': 'Source years or full ISO dates in label_column, sourced event text in value_column. No invented duration.',
  duration: 'Task labels, full ISO start dates in value_column and end_column; ongoing rows require a sourced constant as_of_column.',
  geographic: 'Unique place labels, a nonnegative measure, latitude_column and longitude_column from the source; no guessed coordinates.',
  hierarchy: 'Value, id_column and parent_column with stable source IDs; empty parent denotes a root. Every parent must equal its children and cycles are rejected.',
  flow: 'Directed source labels, to_column, nonnegative edge values and constant cohort_column and period_column. Acyclic; intermediate flows must conserve.',
  funnel: 'Ordered source stages, nonincreasing counts and constant cohort_column and period_column.',
  contribution: 'Ordered source rows: starting total, signed contributions, ending total. Values must reconcile.',
  target: 'Unique labels, actual value_column and comparable sourced target_column; no arbitrary success zones.',
  'small-multiples': 'Unique source dates or years and two to five comparable value_columns; shared axes.',
  'rich-table': 'Exact source table with value_column or value_columns identifying comparable numeric columns for inline bars.',
  editorial: 'Unique dates or years, a numeric measure and annotation_column containing sourced narrative text. Linked navigation stays on the same dataset.',
}

/** Runtime skills: the desk chooses an intent, code enforces its data requirements. */
export const VISUALIZATION_SKILLS = [
  { id: 'ranking', purpose: 'Rank categories by one comparable numeric measure.', needs: 'Unique labels and one numeric column with a consistent unit and observation period.' },
  { id: 'comparison', purpose: 'Compare categories side by side without implying change over time.', needs: 'Unique labels and one comparable numeric measure; qualitative comparisons use table.' },
  { id: 'trend', purpose: 'Show one measure over time with actual spacing between dates.', needs: 'Unique years or ISO dates of the same precision and one numeric measure.' },
  { id: 'range', purpose: 'Show published low and high bounds for each category.', needs: 'Unique categories; value_column is the lower bound and upper_column the upper bound in the same unit. bounds_label must describe the source-defined meaning of the bounds. Do not infer confidence intervals.' },
  { id: 'timeline', purpose: 'Show sourced events in chronological order.', needs: 'Years or ISO dates of the same precision and an event-description column.' },
  { id: 'table', purpose: 'Show exact source cells, including mixed or qualitative comparisons.', needs: 'A captured table; no numerical inference.' },
  { id: 'scatter', purpose: 'Explore the relationship between two numeric measures without implying causation.', needs: 'Paired numeric columns from the same source rows; label_column is the horizontal measure, value_column the vertical measure.' },
  { id: 'distribution', purpose: 'Show the frequency distribution of source observations.', needs: 'Individual observations in value_column, not averages, quantiles, pre-binned counts or aggregated totals. At least three observations.' },
  { id: 'heatmap', purpose: 'Compare intensity across two categorical dimensions.', needs: 'label_column for horizontal categories, group_column for vertical categories and value_column for the numeric measure. Each category pair must be unique.' },
  ...ADVANCED_SKILLS.map((id) => ({ id, purpose: `Create a ${id.replaceAll('-', ' ')} visualization.`, needs: advancedNeeds[id] })),
] as const

export type VisualizationSkill = typeof VISUALIZATION_SKILLS[number]['id']
export const VISUALIZATION_IDS = VISUALIZATION_SKILLS.map((skill) => skill.id)

export const VISUALIZATION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'visualize_table',
    description: `Draw a captured source table on screen without fetching again or supplying any values. Use a table ID returned by read. ${VISUALIZATION_SKILLS.map((skill) => `${skill.id}: ${skill.purpose} Requires: ${skill.needs}`).join(' ')} Check the page's footnotes, definitions, periods and units before requesting a numeric visual. If they are incompatible, choose table. Unsupported inputs fall back to the source table.`,
    parameters: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Exact captured table ID returned by read.' },
        skill: { type: 'string', enum: VISUALIZATION_IDS },
        label_column: { type: 'integer', description: 'Zero-based column for category labels or dates.' },
        value_column: { type: 'integer', description: 'Zero-based numeric measure, or event text for timeline.' },
        group_column: { type: 'integer', description: 'Required for heatmap only: zero-based second categorical dimension.' },
        upper_column: { type: 'integer', description: 'Required for range: zero-based upper-bound column; value_column supplies lower bounds.' },
        bounds_label: { type: 'string', description: 'Required for range: source-defined meaning, for example observed daily minimum and maximum. Never invent a confidence level.' },
        value_columns: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 5, description: 'Comparable source measures for grouped, multi-trend, composition, small-multiples or rich-table.' },
        ...Object.fromEntries(['baseline', 'lower', 'after', 'target', 'total', 'size', 'timezone', 'end', 'as_of', 'latitude', 'longitude', 'id', 'parent', 'to', 'cohort', 'period', 'annotation'].map((role) => [`${role}_column`, { type: 'integer', description: `Zero-based source column for ${role.replaceAll('_', ' ')}; see the chosen skill requirements.` }])),
        row_index: { type: 'integer', description: 'Explicit source row for a statistic when the table has more than one row.' },
        parts_exclusive: { type: 'boolean', description: 'Set true only when the source states that the parts are mutually exclusive.' },
        number_format: { type: 'string', enum: ['plain', 'en-US', 'de-DE', 'fr-FR'], description: 'Advanced skills only: explicitly established source number format; never guess a locale from an ambiguous value.' },
      },
      required: ['table_id', 'skill', 'label_column', 'value_column'],
      additionalProperties: false,
    },
  },
}

export type VisualizationReason = 'ready' | 'no_table' | 'invalid_selection' | 'not_numeric' | 'mixed_units' | 'invalid_dates' | 'duplicate_labels' | 'too_many_rows' | 'insufficient_data' | 'unsupported_context'

/** No source text, URLs or individual values in diagnostic records. */
export interface VisualizationTrace {
  stage: 'capture' | 'selection'
  skill?: VisualizationSkill
  outcome: 'ready' | 'fallback' | 'unavailable'
  reason: VisualizationReason
  rows: number
}
