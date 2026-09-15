import { afterEach, describe, expect, it } from 'vitest'
import { availableTools } from './agent-core'

/**
 * A tool with no key behind it is not offered at all: offering one would buy a
 * holding line and an apology. Research needs Exa, and maps need Mapbox's
 * public token, which every map card carries to the browser.
 */

afterEach(() => {
  delete process.env.EXA_API_KEY
  delete process.env.MAPBOX_PUBLIC_TOKEN
})

describe('the tools a build offers', () => {
  it('leaves out research and maps without their keys', () => {
    process.env.EXA_API_KEY = ''
    process.env.MAPBOX_PUBLIC_TOKEN = ''
    const tools = availableTools()
    expect(tools).not.toContain('research')
    expect(tools).not.toContain('show_map')
    expect(tools).toContain('weather')
  })

  it('offers them once the keys are set', () => {
    process.env.EXA_API_KEY = 'exa-test'
    process.env.MAPBOX_PUBLIC_TOKEN = 'pk.test'
    expect(availableTools()).toEqual(expect.arrayContaining(['research', 'show_map', 'weather']))
  })
})
