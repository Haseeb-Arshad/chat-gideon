import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runStage01Baseline } from '../src/lib/memory-baseline-runner'

describe('stage 01 acceptance and baseline runner', () => {
  it('loads all seed cases, executes C26, and keeps unsupported cases visible', async () => {
    const report = await runStage01Baseline(resolve(process.cwd()))

    expect(report.fixtureSummary).toMatchObject({ totalCases: 36, pass: 1, fail: 0, notImplemented: 35 })
    expect(report.fixtureResults.find((result) => result.caseId === 'C26')).toMatchObject({
      capability: 'truthful-capacity-receipt',
      outcome: 'PASS',
    })
    expect(report.fixtureResults.find((result) => result.caseId === 'C33')).toMatchObject({
      capability: 'durable-quota-receipt',
      outcome: 'NOT_IMPLEMENTED',
    })
    expect(report.corpusMeasurements.map((measurement) => measurement.sampleCount)).toEqual([0, 3, 400])
    expect(report.persistenceMeasurement).toMatchObject({ backend: 'json-memory-local-fixture', ok: true, corpusCount: 1 })
    expect(report.boundaries.rawUserTextLogged).toBe(false)
  })
})
