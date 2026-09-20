/** Bounded analytical forms in the existing chart block contract. */
export const ADVANCED_FORMS = ['dot', 'band', 'slope', 'dumbbell', 'stacked', 'stacked-percent', 'donut', 'waffle', 'box', 'bubble', 'calendar', 'event-timeline', 'gantt', 'geo-symbol', 'treemap', 'sankey', 'funnel', 'waterfall', 'bullet', 'small-multiples', 'editorial'] as const
export type AdvancedForm = typeof ADVANCED_FORMS[number]
export const isAdvancedForm = (value: unknown): value is AdvancedForm => typeof value === 'string' && (ADVANCED_FORMS as readonly string[]).includes(value)

/** Every field is copied from source columns or computed by a named transform. */
export interface AnalysisContext {
  meaning?: string
  denominator?: string
  totals?: number[]
  timezone?: string
  period?: string
  cohort?: string
  ids?: string[]
  parents?: string[]
  targets?: string[]
  annotations?: string[]
  sampleSizes?: number[]
  outliers?: number[][]
  units?: string[]
}

export interface ChartEvidence {
  datasetId: string
  version: string
  fetchedAt: string
  sourceUrl: string
  columns: number[]
  rows: Array<{ id: string; line: number }>
  transforms: string[]
}
