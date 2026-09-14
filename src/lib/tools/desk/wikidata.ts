/**
 * The structured record of a person, place, organisation or work, from Wikidata.
 *
 * Search passages say "born in Warsaw in 1867" in a hundred different ways,
 * and a card copying a date out of one of them has to trust that it read it
 * right. Wikidata says it once, as data: a date with its precision, a place as
 * an identifier with a name. So the desk looks a subject up here, and the card
 * lays out the answer rather than a model's reading of a page.
 *
 * Wikidata keeps history as well as the present: Japan has had nine capitals
 * and thirty-seven population counts. Only the best-ranked statements are used
 * (preferred where there is one, otherwise normal, never deprecated), and of
 * several counts, the most recent. A value this cannot read is left out rather
 * than guessed at.
 *
 * No key. CC0, credited on the card anyway.
 */

import type { RecordEvent, RecordField, RecordMaterial } from '../../cards/materials'
import { TimedCache } from './cache'
import type { DeskLookup } from './world-bank'

const API = 'https://www.wikidata.org/w/api.php'
/** Wikimedia asks every API client to say who it is. */
const USER_AGENT = 'GIDEON/1.0 (voice companion; research cards)'
const TIMEOUT_MS = 6_000
/** A comparison table holds four subjects, so a request does too. */
export const MAX_TITLES = 4
const MAX_EVENTS = 12

export interface WikidataDeps {
  fetch: typeof fetch
  now: () => number
}

interface DataValue {
  type?: string
  value?: unknown
}

interface Snak {
  snaktype?: string
  datavalue?: DataValue
}

interface Claim {
  rank?: string
  mainsnak?: Snak
  qualifiers?: Record<string, Snak[]>
}

interface Entity {
  id?: string
  missing?: string
  labels?: Record<string, { value?: string }>
  descriptions?: Record<string, { value?: string }>
  claims?: Record<string, Claim[]>
  sitelinks?: Record<string, { title?: string }>
}

// -- Reading values -----------------------------------------------------------

/** The statements that describe the present: preferred if any are, otherwise normal. */
function best(claims: Claim[] | undefined): Claim[] {
  const usable = (claims ?? []).filter(
    (claim) => claim.rank !== 'deprecated' && claim.mainsnak?.snaktype === 'value' && claim.mainsnak.datavalue,
  )
  const preferred = usable.filter((claim) => claim.rank === 'preferred')
  return preferred.length ? preferred : usable
}

function itemId(snak: Snak | undefined): string | null {
  const value = snak?.datavalue?.value as { id?: unknown } | undefined
  return typeof value?.id === 'string' && /^Q\d+$/.test(value.id) ? value.id : null
}

interface Time {
  year: number
  month: number
  day: number
  precision: number
}

function timeOf(snak: Snak | undefined): Time | null {
  const value = snak?.datavalue?.value as { time?: unknown; precision?: unknown } | undefined
  if (typeof value?.time !== 'string' || typeof value.precision !== 'number') return null
  const match = value.time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1)
  if (!Number.isFinite(year) || year === 0) return null
  return { year, month: Number(match[3]), day: Number(match[4]), precision: value.precision }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/** A date at the precision Wikidata holds it: a day, a month, a year, a decade or a century. */
export function formatTime(time: Time): string {
  const year = time.year < 0 ? `${-time.year} BC` : String(time.year)
  if (time.precision >= 11 && time.day && time.month) return `${time.day} ${MONTHS[time.month - 1]} ${year}`
  if (time.precision === 10 && time.month) return `${MONTHS[time.month - 1]} ${year}`
  if (time.precision === 9) return year
  if (time.precision === 8 && time.year > 0) return `${Math.floor(time.year / 10) * 10}s`
  if (time.precision === 7 && time.year > 0) return `${ordinal(Math.ceil(time.year / 100))} century`
  return year
}

function sortOf(time: Time): number {
  const month = time.precision >= 10 ? time.month : 0
  const day = time.precision >= 11 ? time.day : 0
  return time.year * 10_000 + month * 100 + day
}

/** Units worth showing. Anything else is left off rather than shown without its unit. */
const UNITS: Record<string, string> = {
  '1': '',
  Q712226: 'km²',
  Q25343: 'm²',
  Q35852: 'ha',
  Q11573: 'm',
  Q828224: 'km',
  Q174728: 'cm',
}

function quantityOf(snak: Snak | undefined): { amount: number; unit: string } | null {
  const value = snak?.datavalue?.value as { amount?: unknown; unit?: unknown } | undefined
  if (typeof value?.amount !== 'string' || typeof value.unit !== 'string') return null
  const amount = Number(value.amount)
  const unitId = value.unit === '1' ? '1' : (value.unit.match(/(Q\d+)$/)?.[1] ?? '')
  if (!Number.isFinite(amount) || !Object.hasOwn(UNITS, unitId)) return null
  return { amount, unit: UNITS[unitId] }
}

function formatQuantity({ amount, unit }: { amount: number; unit: string }): string {
  const decimals = Math.abs(amount) >= 100 ? 0 : 1
  const text = amount.toLocaleString('en-GB', { maximumFractionDigits: decimals })
  return unit ? `${text} ${unit}` : text
}

/** Of several dated statements, the most recent: the latest population count, not the first. */
function latest(claims: Claim[]): Claim | undefined {
  let chosen: Claim | undefined
  let chosenSort = -Infinity
  for (const claim of claims) {
    const when = timeOf(claim.qualifiers?.P585?.[0])
    const sort = when ? sortOf(when) : -Infinity
    if (!chosen || sort > chosenSort) {
      chosen = claim
      chosenSort = sort
    }
  }
  return chosen
}

// -- What a record is, and what it shows ----------------------------------------------

const COUNTRY_CLASSES = new Set(['Q6256', 'Q3624078'])

function has(entity: Entity, property: string): boolean {
  return best(entity.claims?.[property]).length > 0
}

export function typeOf(entity: Entity): RecordMaterial['type'] {
  const classes = new Set(best(entity.claims?.P31).map((claim) => itemId(claim.mainsnak)))
  if (classes.has('Q5')) return 'person'
  if ([...classes].some((id) => id && COUNTRY_CLASSES.has(id))) return 'country'
  const counted = has(entity, 'P1082') || has(entity, 'P2046')
  if (!counted && ['P50', 'P57', 'P175', 'P577'].some((property) => has(entity, property))) return 'work'
  if (has(entity, 'P625') && (counted || has(entity, 'P2044') || has(entity, 'P17'))) {
    if (!['P159', 'P169', 'P452', 'P1128'].some((property) => has(entity, property))) return 'place'
  }
  if (['P159', 'P112', 'P169', 'P452', 'P1128'].some((property) => has(entity, property))) return 'organisation'
  return has(entity, 'P625') ? 'place' : 'thing'
}

type Labels = Map<string, string>

interface FieldRule {
  key: string
  label: string
  read: (entity: Entity, labels: Labels) => string
}

const names =
  (property: string, limit: number) =>
  (entity: Entity, labels: Labels): string => {
    const shown: string[] = []
    for (const claim of best(entity.claims?.[property])) {
      const name = labels.get(itemId(claim.mainsnak) ?? '')
      if (name && !shown.includes(name)) shown.push(name)
      if (shown.length === limit) break
    }
    return shown.join(', ')
  }

const dateWithPlace =
  (dateProperty: string, placeProperty: string) =>
  (entity: Entity, labels: Labels): string => {
    const time = timeOf(best(entity.claims?.[dateProperty])[0]?.mainsnak)
    if (!time) return ''
    const place = names(placeProperty, 1)(entity, labels)
    return place ? `${formatTime(time)}, ${place}` : formatTime(time)
  }

const date =
  (property: string) =>
  (entity: Entity): string => {
    const times = best(entity.claims?.[property])
      .map((claim) => timeOf(claim.mainsnak))
      .filter((time): time is Time => time !== null)
      .sort((a, b) => sortOf(a) - sortOf(b))
    return times[0] ? formatTime(times[0]) : ''
  }

const quantity =
  (property: string, dated = false) =>
  (entity: Entity): string => {
    const claims = best(entity.claims?.[property])
    const claim = dated ? latest(claims) : claims[0]
    const value = quantityOf(claim?.mainsnak)
    if (!value) return ''
    const when = dated ? timeOf(claim?.qualifiers?.P585?.[0]) : null
    return when ? `${formatQuantity(value)} (${when.year})` : formatQuantity(value)
  }

const FIELDS: Record<RecordMaterial['type'], FieldRule[]> = {
  person: [
    { key: 'born', label: 'Born', read: dateWithPlace('P569', 'P19') },
    { key: 'died', label: 'Died', read: dateWithPlace('P570', 'P20') },
    { key: 'occupation', label: 'Occupation', read: names('P106', 3) },
    { key: 'known_for', label: 'Known for', read: names('P800', 3) },
    { key: 'awards', label: 'Awards', read: names('P166', 3) },
    { key: 'educated', label: 'Educated at', read: names('P69', 2) },
    { key: 'spouse', label: 'Spouse', read: names('P26', 2) },
  ],
  country: [
    { key: 'capital', label: 'Capital', read: names('P36', 1) },
    { key: 'population', label: 'Population', read: quantity('P1082', true) },
    { key: 'area', label: 'Area', read: quantity('P2046') },
    { key: 'languages', label: 'Official languages', read: names('P37', 2) },
    { key: 'currency', label: 'Currency', read: names('P38', 2) },
    { key: 'head_of_state', label: 'Head of state', read: names('P35', 1) },
    { key: 'head_of_government', label: 'Head of government', read: names('P6', 1) },
    { key: 'continent', label: 'Continent', read: names('P30', 2) },
  ],
  place: [
    { key: 'country', label: 'Country', read: names('P17', 1) },
    { key: 'located_in', label: 'Located in', read: names('P131', 1) },
    { key: 'population', label: 'Population', read: quantity('P1082', true) },
    { key: 'area', label: 'Area', read: quantity('P2046') },
    { key: 'elevation', label: 'Elevation', read: quantity('P2044') },
    { key: 'height', label: 'Height', read: quantity('P2048') },
    { key: 'established', label: 'Established', read: date('P571') },
    { key: 'opened', label: 'Opened', read: date('P1619') },
    { key: 'architect', label: 'Architect', read: names('P84', 2) },
  ],
  organisation: [
    { key: 'founded', label: 'Founded', read: date('P571') },
    { key: 'founders', label: 'Founders', read: names('P112', 3) },
    { key: 'headquarters', label: 'Headquarters', read: names('P159', 1) },
    { key: 'ceo', label: 'Chief executive', read: names('P169', 1) },
    { key: 'industry', label: 'Industry', read: names('P452', 2) },
    { key: 'employees', label: 'Employees', read: quantity('P1128', true) },
    { key: 'country', label: 'Country', read: names('P17', 1) },
  ],
  work: [
    { key: 'author', label: 'Author', read: names('P50', 2) },
    { key: 'director', label: 'Director', read: names('P57', 2) },
    { key: 'performer', label: 'Performer', read: names('P175', 2) },
    { key: 'published', label: 'Published', read: date('P577') },
    { key: 'genre', label: 'Genre', read: names('P136', 2) },
    { key: 'publisher', label: 'Publisher', read: names('P123', 1) },
  ],
  thing: [
    { key: 'inception', label: 'Introduced', read: date('P571') },
    { key: 'developer', label: 'Developer', read: names('P178', 1) },
    { key: 'manufacturer', label: 'Maker', read: names('P176', 1) },
    { key: 'country', label: 'Country', read: names('P17', 1) },
  ],
}

/**
 * Every item a record's fields and events name, so their names can be asked for
 * in one request: the properties below are every one a field or an event reads
 * an item from.
 */
function referencedItems(entity: Entity): string[] {
  const ids = new Set<string>()
  for (const property of [
    'P19', 'P20', 'P106', 'P800', 'P166', 'P69', 'P26', 'P36', 'P37', 'P38', 'P35', 'P6', 'P30', 'P17', 'P131',
    'P84', 'P112', 'P159', 'P169', 'P452', 'P50', 'P57', 'P175', 'P136', 'P123', 'P178', 'P176', 'P39', 'P793',
  ]) {
    for (const claim of best(entity.claims?.[property])) {
      const id = itemId(claim.mainsnak)
      if (id) ids.add(id)
    }
  }
  return [...ids].slice(0, 50)
}

/** A structure is built and opened; a town is founded. Only the words differ. */
function isStructure(entity: Entity): boolean {
  return ['P1619', 'P84', 'P2048'].some((property) => has(entity, property))
}

/** Awards on a person's line: the first few Wikidata lists, as the Awards field shows them. */
const AWARDS_ON_A_LINE = 3

/**
 * What a record's timeline shows.
 *
 * The events that frame a subject (born and died, founded and dissolved,
 * opened, published) always stay: Marie Curie has thirty-odd dated awards, and
 * keeping the earliest twelve events of all of them ended her life in 1921.
 * Awards join a person's or a work's line only as the few the record lists
 * first, and a place's or an organisation's significant events join theirs.
 * Neither joins a country's, whose events are whatever an editor added last.
 */
function events(entity: Entity, type: RecordMaterial['type'], labels: Labels): RecordEvent[] {
  const framing: RecordEvent[] = []
  const extra: RecordEvent[] = []
  const add = (into: RecordEvent[], time: Time | null, label: string) => {
    if (!time || !label) return
    if ([...framing, ...extra].some((event) => event.label === label && event.sort === sortOf(time))) return
    into.push({ date: formatTime(time), sort: sortOf(time), label })
  }
  const first = (property: string) => timeOf(best(entity.claims?.[property])[0]?.mainsnak)
  const place = (property: string) => labels.get(itemId(best(entity.claims?.[property])[0]?.mainsnak) ?? '')
  const dated = (property: string, qualifier: string, into: RecordEvent[], limit = Infinity) => {
    let added = 0
    for (const claim of best(entity.claims?.[property])) {
      if (added === limit) break
      const before = into.length
      add(into, timeOf(claim.qualifiers?.[qualifier]?.[0]), labels.get(itemId(claim.mainsnak) ?? '') ?? '')
      if (into.length > before) added += 1
    }
  }

  if (type === 'person') {
    const birthPlace = place('P19')
    add(framing, first('P569'), birthPlace ? `Born in ${birthPlace}` : 'Born')
    const deathPlace = place('P20')
    add(framing, first('P570'), deathPlace ? `Died in ${deathPlace}` : 'Died')
    dated('P39', 'P580', extra)
    dated('P166', 'P585', extra, AWARDS_ON_A_LINE)
  }
  if (type === 'organisation') {
    add(framing, first('P571'), 'Founded')
    add(framing, first('P576'), 'Dissolved')
    dated('P793', 'P585', extra)
  }
  if (type === 'place') {
    const structure = isStructure(entity)
    add(framing, first('P571'), structure ? 'Construction began' : 'Established')
    add(framing, first('P1619'), 'Opened')
    dated('P793', 'P585', extra)
  }
  if (type === 'work') {
    add(framing, first('P577'), 'Published')
    dated('P166', 'P585', extra, AWARDS_ON_A_LINE)
  }

  const room = Math.max(0, MAX_EVENTS - framing.length)
  return [...framing, ...extra.sort((a, b) => a.sort - b.sort).slice(0, room)].sort((a, b) => a.sort - b.sort)
}

export function recordFrom(entity: Entity, labels: Labels, fetchedAt: string): RecordMaterial | null {
  const subject = nameOf(entity)
  if (!entity.id || !subject) return null
  const type = typeOf(entity)
  const fields: RecordField[] = []
  const structure = type === 'place' && isStructure(entity)
  for (const rule of FIELDS[type]) {
    const value = rule.read(entity, labels).trim()
    // Lisbon is in the municipality of Lisbon; saying so says nothing.
    if (!value || value.toLowerCase() === subject.toLowerCase()) continue
    const label = structure && rule.key === 'established' ? 'Construction began' : rule.label
    fields.push({ key: rule.key, label, value })
  }
  const coordinates = best(entity.claims?.P625)[0]?.mainsnak?.datavalue?.value as
    | { latitude?: unknown; longitude?: unknown }
    | undefined
  const wikipedia = entity.sitelinks?.enwiki?.title?.trim()
  return {
    id: `wikidata:${entity.id}`,
    kind: 'record',
    type,
    subject,
    description: entity.descriptions?.en?.value?.trim() ?? '',
    fields,
    events: events(entity, type, labels),
    ...(wikipedia ? { wikipedia } : {}),
    ...(typeof coordinates?.latitude === 'number' && typeof coordinates.longitude === 'number'
      ? { coordinates: { latitude: coordinates.latitude, longitude: coordinates.longitude } }
      : {}),
    source: { title: 'Wikidata', url: `https://www.wikidata.org/wiki/${entity.id}`, fetchedAt },
  }
}

// -- Asking Wikidata ------------------------------------------------------------------

async function get(params: Record<string, string>, deps: WikidataDeps): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })
  const response = await deps.fetch(`${API}?${query}`, {
    headers: { 'Api-User-Agent': USER_AGENT, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    void response.body?.cancel()
    throw new Error(`wikidata ${response.status}`)
  }
  return (await response.json()) as Record<string, unknown>
}

const ENTITY_PROPS = 'labels|descriptions|claims|sitelinks'
/**
 * English, and the label shared by every language. Since 2025 Wikidata keeps a
 * name that is the same everywhere, such as a person's, only under "mul", so an
 * item asked for in English alone can come back with no name at all.
 */
const LANGUAGES = 'en|mul'

function nameOf(entity: Entity): string {
  return (entity.labels?.en?.value ?? entity.labels?.mul?.value ?? '').trim()
}

function firstEntity(body: Record<string, unknown>): Entity | null {
  const entities = body.entities as Record<string, Entity> | Entity[] | undefined
  const list = Array.isArray(entities) ? entities : Object.values(entities ?? {})
  const entity = list[0]
  return entity && !('missing' in entity) && entity.id ? entity : null
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !['the', 'and', 'of'].includes(word)),
  )
}

/**
 * The entity an English Wikipedia title belongs to. The exact title is certain;
 * a search is the fallback for a title that is only nearly right, and its
 * answer is kept only when its name shares a word with what was asked for.
 */
async function resolve(title: string, deps: WikidataDeps): Promise<Entity | null> {
  const exact = firstEntity(
    await get({ action: 'wbgetentities', sites: 'enwiki', titles: title, normalize: '1', props: ENTITY_PROPS, languages: LANGUAGES, sitefilter: 'enwiki' }, deps),
  )
  if (exact) return exact

  const found = await get({ action: 'wbsearchentities', search: title, language: 'en', type: 'item', limit: '5' }, deps)
  const asked = significantWords(title)
  const candidates = (found.search as Array<{ id?: string; label?: string }> | undefined) ?? []
  const match = candidates.find((candidate) => {
    const words = significantWords(candidate.label ?? '')
    return candidate.id && [...asked].some((word) => words.has(word))
  })
  if (!match?.id) return null
  return firstEntity(
    await get({ action: 'wbgetentities', ids: match.id, props: ENTITY_PROPS, languages: LANGUAGES, sitefilter: 'enwiki' }, deps),
  )
}

async function lookup(title: string, deps: WikidataDeps): Promise<RecordMaterial | null> {
  const entity = await resolve(title, deps)
  if (!entity) return null
  const ids = referencedItems(entity)
  const labels: Labels = new Map()
  if (ids.length) {
    const named = await get({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: LANGUAGES }, deps)
    const entities = named.entities as Record<string, Entity> | undefined
    for (const [id, item] of Object.entries(entities ?? {})) {
      const label = nameOf(item)
      if (label) labels.set(id, label)
    }
  }
  return recordFrom(entity, labels, new Date(deps.now()).toISOString())
}

const cache = new TimedCache<RecordMaterial | null>(24 * 60 * 60_000)

/** A record in words, for the desk to brief with. */
export function describeRecord(record: RecordMaterial): string {
  const lines = [`${record.subject}${record.description ? `: ${record.description}` : ''}`]
  for (const field of record.fields) lines.push(`${field.label}: ${field.value}`)
  if (record.events.length) lines.push(`Timeline: ${record.events.map((event) => `${event.date} ${event.label}`).join('; ')}`)
  return lines.join('\n')
}

export interface EntityFactsArgs {
  titles: string[]
}

/** Records for up to four subjects, and the words to brief with. Never rejects but on abort. */
export async function entityFacts(
  args: EntityFactsArgs,
  deps: WikidataDeps,
  signal: AbortSignal,
): Promise<DeskLookup<RecordMaterial>> {
  const titles = [
    ...new Set(
      (Array.isArray(args.titles) ? args.titles : [])
        .map((title) => (typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''))
        .filter(Boolean),
    ),
  ]
  if (!titles.length) return { ok: false, text: 'Give the title of the English Wikipedia article for each subject.' }
  if (titles.length > MAX_TITLES) return { ok: false, text: `Ask for at most ${MAX_TITLES} subjects at a time.` }

  let found: Array<RecordMaterial | null>
  try {
    found = await Promise.race([
      Promise.all(
        titles.map((title) =>
          cache.get(title.toLowerCase(), () => lookup(title, deps), (record) => record !== null).catch(() => null),
        ),
      ),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, text: 'Wikidata could not be reached just now. Answer from search instead.' }
  }

  const records = found.filter((record): record is RecordMaterial => record !== null)
  const missing = titles.filter((_, index) => !found[index])
  const notFound = missing.length ? `\nNo Wikidata record was found for ${missing.join(', ')}.` : ''
  if (!records.length) return { ok: false, text: `No Wikidata record was found for ${titles.join(', ')}. Answer from search instead.` }

  return {
    ok: true,
    materials: records,
    text: `Wikidata\n${records.map(describeRecord).join('\n\n')}${notFound}\nThese facts are shown on the user's screen. Use them exactly as given, and rely on search for anything recent.`,
  }
}

/** For tests: forget every lookup. */
export function forgetWikidata() {
  cache.clear()
}
