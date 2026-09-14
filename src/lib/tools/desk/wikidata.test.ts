import { beforeEach, describe, expect, it, vi } from 'vitest'
import { entityFacts, forgetWikidata, formatTime, recordFrom, typeOf, type WikidataDeps } from './wikidata'

/**
 * The Wikidata source, against entities shaped like the live API's. The cases
 * are the ones that go wrong quietly: a name kept only as a shared label,
 * history mixed in with the present, a count taken from the wrong year, a unit
 * that cannot be shown.
 */

const NOW = Date.UTC(2026, 8, 14)

const item = (id: string) => ({ snaktype: 'value', datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', id } } })
const time = (value: string, precision = 11) => ({
  snaktype: 'value',
  datavalue: { type: 'time', value: { time: value, precision, timezone: 0, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' } },
})
const amount = (value: string, unit = '1') => ({
  snaktype: 'value',
  datavalue: { type: 'quantity', value: { amount: value, unit: unit === '1' ? '1' : `http://www.wikidata.org/entity/${unit}` } },
})
interface FixtureSnak {
  snaktype?: string
  datavalue?: { type?: string; value?: unknown }
}

const claim = (mainsnak: FixtureSnak, rank = 'normal', qualifiers?: Record<string, FixtureSnak[]>) => ({
  mainsnak,
  rank,
  ...(qualifiers ? { qualifiers } : {}),
})

const CURIE = {
  id: 'Q7186',
  // Since 2025 a name that is the same in every language is kept only under "mul".
  labels: { mul: { language: 'mul', value: 'Marie Curie' } },
  descriptions: { en: { language: 'en', value: 'Polish-born French physicist and chemist (1867–1934)' } },
  sitelinks: { enwiki: { site: 'enwiki', title: 'Marie Curie' } },
  claims: {
    P31: [claim(item('Q5'))],
    P569: [claim(time('+1867-11-07T00:00:00Z'))],
    P19: [claim(item('Q270'))],
    P570: [claim(time('+1934-07-04T00:00:00Z'))],
    P20: [claim(item('Q2364887'))],
    P106: [claim(item('Q169470')), claim(item('Q593644')), claim(item('Q169470'))],
    P166: [
      claim(item('Q38104'), 'normal', { P585: [time('+1903-01-01T00:00:00Z', 9)] }),
      claim(item('Q44585'), 'normal', { P585: [time('+1911-01-01T00:00:00Z', 9)] }),
      // No date, so it names an award but has no place on a timeline.
      claim(item('Q902788')),
    ],
    P26: [claim(item('Q37463'))],
    // A wrong statement kept for the record, never shown.
    P69: [claim(item('Q9999'), 'deprecated'), claim(item('Q209842'))],
  },
}

const JAPAN = {
  id: 'Q17',
  labels: { en: { language: 'en', value: 'Japan' } },
  descriptions: { en: { language: 'en', value: 'island country in East Asia' } },
  sitelinks: { enwiki: { site: 'enwiki', title: 'Japan' } },
  claims: {
    P31: [claim(item('Q6256')), claim(item('Q112099'))],
    // Nine capitals in its history; the present one is preferred.
    P36: [claim(item('Q1207735')), claim(item('Q1490'), 'preferred')],
    // Many counts; the latest one wins among the best-ranked.
    P1082: [
      claim(amount('+124631000'), 'normal', { P585: [time('+2023-02-01T00:00:00Z', 10)] }),
      claim(amount('+123802000'), 'normal', { P585: [time('+2024-10-01T00:00:00Z', 10)] }),
      claim(amount('+127094745'), 'normal', { P585: [time('+2015-10-01T00:00:00Z', 10)] }),
    ],
    P2046: [claim(amount('+377972.28', 'Q712226'))],
    // A unit this does not know is left off rather than shown bare.
    P2044: [claim(amount('+438', 'Q3710'))],
    P38: [claim(item('Q8146'))],
    P625: [claim({ snaktype: 'value', datavalue: { type: 'globecoordinate', value: { latitude: 35, longitude: 136 } } })],
    P571: [claim(time('+1947-05-03T00:00:00Z'), 'preferred')],
  },
}

const LABELS: Record<string, string> = {
  Q270: 'Warsaw',
  Q2364887: 'Passy',
  Q169470: 'physicist',
  Q593644: 'chemist',
  Q38104: 'Nobel Prize in Physics',
  Q44585: 'Nobel Prize in Chemistry',
  Q902788: 'Davy Medal',
  Q37463: 'Pierre Curie',
  Q209842: 'University of Paris',
  Q9999: 'Wrong School',
  Q1490: 'Tokyo',
  Q1207735: 'Kyoto',
  Q8146: 'Japanese yen',
}

const labels = new Map(Object.entries(LABELS))

function world(entities: Record<string, unknown>, search: Array<{ id: string; label: string }> = []) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect((init?.headers as Record<string, string>)['User-Agent']).toMatch(/^GIDEON/)
    const params = url.searchParams
    if (params.get('action') === 'wbsearchentities') return Response.json({ search })
    if (params.get('titles')) {
      const found = Object.values(entities).find(
        (entity) => (entity as typeof CURIE).sitelinks?.enwiki?.title === params.get('titles'),
      )
      return Response.json({ entities: found ? { [(found as { id: string }).id]: found } : { '-1': { site: 'enwiki', title: params.get('titles'), missing: '' } } })
    }
    const ids = (params.get('ids') ?? '').split('|')
    if (params.get('props') === 'labels') {
      expect(params.get('languages')).toBe('en|mul')
      return Response.json({ entities: Object.fromEntries(ids.map((id) => [id, { id, labels: LABELS[id] ? { en: { value: LABELS[id] } } : {} }])) })
    }
    return Response.json({ entities: Object.fromEntries(ids.filter((id) => entities[id]).map((id) => [id, entities[id]])) })
  })
  const deps: WikidataDeps = { fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW }
  return { fetch, deps }
}

const live = () => new AbortController().signal

beforeEach(() => forgetWikidata())

describe('a person', () => {
  const record = recordFrom(CURIE, labels, '2026-09-14T00:00:00.000Z')!

  it('is named by the shared label when there is no English one', () => {
    expect(record).toMatchObject({
      id: 'wikidata:Q7186',
      kind: 'record',
      type: 'person',
      subject: 'Marie Curie',
      wikipedia: 'Marie Curie',
      source: { title: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q7186' },
    })
  })

  it('reads dates with their places, names once each, and never a deprecated statement', () => {
    expect(record.fields).toEqual([
      { key: 'born', label: 'Born', value: '7 November 1867, Warsaw' },
      { key: 'died', label: 'Died', value: '4 July 1934, Passy' },
      { key: 'occupation', label: 'Occupation', value: 'physicist, chemist' },
      { key: 'awards', label: 'Awards', value: 'Nobel Prize in Physics, Nobel Prize in Chemistry, Davy Medal' },
      { key: 'educated', label: 'Educated at', value: 'University of Paris' },
      { key: 'spouse', label: 'Spouse', value: 'Pierre Curie' },
    ])
  })

  it('puts dated events in order, and leaves out an award with no date', () => {
    expect(record.events.map(({ date, label }) => `${date} ${label}`)).toEqual([
      '7 November 1867 Born in Warsaw',
      '1903 Nobel Prize in Physics',
      '1911 Nobel Prize in Chemistry',
      '4 July 1934 Died in Passy',
    ])
  })

  it('keeps a death on the line however many awards came first', () => {
    // Measured on the live record: thirty-odd dated awards once ended her life in 1921.
    const awards = Array.from({ length: 20 }, (_, index) =>
      claim(item(`Q${500 + index}`), 'normal', { P585: [time(`+${1898 + index}-01-01T00:00:00Z`, 9)] }),
    )
    const named = new Map([...labels, ...awards.map((_, index): [string, string] => [`Q${500 + index}`, `Award ${index}`])])
    const busy = recordFrom({ ...CURIE, claims: { ...CURIE.claims, P166: awards } }, named, '2026-09-14T00:00:00.000Z')!
    const line = busy.events.map(({ label }) => label)
    expect(line[0]).toBe('Born in Warsaw')
    expect(line.at(-1)).toBe('Died in Passy')
    // The first few awards the record lists, not all of them.
    expect(line.filter((label) => label.startsWith('Award'))).toEqual(['Award 0', 'Award 1', 'Award 2'])
  })
})

describe('a city', () => {
  it('does not say it is located in a place of its own name', () => {
    const lisbon = recordFrom(
      {
        id: 'Q597',
        labels: { en: { value: 'Lisbon' } },
        claims: {
          P625: [claim({ snaktype: 'value', datavalue: { value: { latitude: 38.7, longitude: -9.1 } } })],
          P17: [claim(item('Q45'))],
          // The city of Lisbon is in the municipality of Lisbon.
          P131: [claim(item('Q2000'))],
          P1082: [claim(amount('+545796'), 'normal', { P585: [time('+2021-01-01T00:00:00Z', 9)] })],
        },
      },
      new Map([
        ['Q45', 'Portugal'],
        ['Q2000', 'Lisbon'],
      ]),
      '2026-09-14T00:00:00.000Z',
    )!
    expect(lisbon.fields.map(({ label }) => label)).toEqual(['Country', 'Population'])
  })
})

describe('a structure', () => {
  it('began construction rather than being established, and opened', () => {
    const tower = recordFrom(
      {
        id: 'Q243',
        labels: { en: { value: 'Eiffel Tower' } },
        claims: {
          P625: [claim({ snaktype: 'value', datavalue: { value: { latitude: 48.858, longitude: 2.294 } } })],
          P17: [claim(item('Q142'))],
          P2048: [claim(amount('+330', 'Q11573'))],
          P571: [claim(time('+1887-01-28T00:00:00Z'))],
          P1619: [claim(time('+1889-03-31T00:00:00Z'))],
        },
      },
      new Map([['Q142', 'France']]),
      '2026-09-14T00:00:00.000Z',
    )!
    expect(tower.type).toBe('place')
    expect(tower.fields.map(({ label, value }) => `${label}: ${value}`)).toEqual([
      'Country: France',
      'Height: 330 m',
      'Construction began: 28 January 1887',
      'Opened: 31 March 1889',
    ])
    expect(tower.events.map(({ label }) => label)).toEqual(['Construction began', 'Opened'])
  })
})

describe('a country', () => {
  const record = recordFrom(JAPAN, labels, '2026-09-14T00:00:00.000Z')!

  it('shows the present capital, the latest population and a unit it can name', () => {
    expect(record.type).toBe('country')
    expect(record.fields).toEqual([
      { key: 'capital', label: 'Capital', value: 'Tokyo' },
      { key: 'population', label: 'Population', value: '123,802,000 (2024)' },
      { key: 'area', label: 'Area', value: '377,972 km²' },
      { key: 'currency', label: 'Currency', value: 'Japanese yen' },
    ])
    expect(record.coordinates).toEqual({ latitude: 35, longitude: 136 })
    // A country's constitution is not its founding; no inception event for a country.
    expect(record.events).toEqual([])
  })
})

describe('reading dates and types', () => {
  it('formats each precision, and years before the common era', () => {
    expect(formatTime({ year: 1867, month: 11, day: 7, precision: 11 })).toBe('7 November 1867')
    expect(formatTime({ year: 1969, month: 7, day: 1, precision: 10 })).toBe('July 1969')
    expect(formatTime({ year: 1903, month: 1, day: 1, precision: 9 })).toBe('1903')
    expect(formatTime({ year: 1867, month: 0, day: 0, precision: 8 })).toBe('1860s')
    expect(formatTime({ year: 1801, month: 0, day: 0, precision: 7 })).toBe('19th century')
    expect(formatTime({ year: -44, month: 3, day: 15, precision: 9 })).toBe('44 BC')
  })

  it('tells places, organisations and works apart by what they have', () => {
    const with_ = (claims: Record<string, unknown[]>) => ({ id: 'Q1', claims }) as never
    expect(typeOf(with_({ P625: [claim({ snaktype: 'value', datavalue: { value: {} } })], P1082: [claim(amount('+100'))] }))).toBe('place')
    expect(typeOf(with_({ P159: [claim(item('Q2'))], P625: [claim({ snaktype: 'value', datavalue: { value: {} } })], P17: [claim(item('Q3'))] }))).toBe('organisation')
    expect(typeOf(with_({ P50: [claim(item('Q2'))], P577: [claim(time('+1949-06-08T00:00:00Z'))] }))).toBe('work')
    expect(typeOf(with_({}))).toBe('thing')
  })
})

describe('entityFacts', () => {
  it('looks each title up exactly, names what it refers to in one request, and describes the records', async () => {
    const { fetch, deps } = world({ Q7186: CURIE, Q17: JAPAN })
    const result = await entityFacts({ titles: ['Marie Curie', 'Japan'] }, deps, live())
    expect(result.ok && result.materials.map((record) => record.subject)).toEqual(['Marie Curie', 'Japan'])
    // Two lookups each: the entity, then the names of what it refers to.
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(result.text).toContain('Marie Curie: Polish-born French physicist and chemist (1867–1934)')
    expect(result.text).toContain('Born: 7 November 1867, Warsaw')
    expect(result.text).toContain('Timeline: 7 November 1867 Born in Warsaw; 1903 Nobel Prize in Physics')
  })

  it('falls back to search for a title that is only nearly right, and only keeps a match that shares a word', async () => {
    let { deps } = world({ Q7186: CURIE }, [{ id: 'Q7186', label: 'Marie Curie' }])
    const near = await entityFacts({ titles: ['Madame Curie'] }, deps, live())
    expect(near.ok && near.materials[0].subject).toBe('Marie Curie')

    forgetWikidata()
    ;({ deps } = world({ Q7186: CURIE }, [{ id: 'Q7186', label: 'Marie Curie' }]))
    const unrelated = await entityFacts({ titles: ['Radium Girls'] }, deps, live())
    expect(unrelated).toEqual({ ok: false, text: expect.stringContaining('No Wikidata record was found for Radium Girls') })
  })

  it('reports the titles it found nothing for beside the ones it did', async () => {
    const { deps } = world({ Q17: JAPAN })
    const result = await entityFacts({ titles: ['Japan', 'Atlantis'] }, deps, live())
    expect(result.ok).toBe(true)
    expect(result.text).toContain('No Wikidata record was found for Atlantis')
  })

  it('refuses no titles or too many, before asking', async () => {
    const { fetch, deps } = world({})
    expect((await entityFacts({ titles: [] }, deps, live())).ok).toBe(false)
    expect((await entityFacts({ titles: ['a', 'b', 'c', 'd', 'e'] }, deps, live())).text).toContain('at most 4')
    expect(fetch).not.toHaveBeenCalled()
  })
})
