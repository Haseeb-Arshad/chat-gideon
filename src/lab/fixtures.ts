/**
 * Cards for the lab: one for every recipe the stage can draw, filled the way
 * a real one is, so a layout can be judged without spending a search.
 *
 * Pictures are drawn in place as small SVGs, so the lab needs no network and
 * nothing in it can fail to load. Sample figures are marked as samples.
 */

import { cardFromMaterials } from '../lib/cards/from-materials'
import { placeCard, routeCard, type MapPlace } from '../lib/cards/maps'
import { withPlaceMap } from '../lib/tools/weather'
import type { Material, StoriesMaterial } from '../lib/cards/materials'
import type { Block, CardPicture, CardV2 } from '../lib/cards/schema'
import { LIFE_EXPECTANCY_JPN, LISBON, MARIE_CURIE, POPULATION_CHN, POPULATION_JPN, POPULATION_KOR, PORTO, WEATHER_BERGEN, WEATHER_LISBON } from './materials'

function svg(width: number, height: number, from: string, to: string, label: string): string {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/><text x="50%" y="54%" font-family="Georgia, serif" font-size="${Math.round(height / 7)}" fill="rgba(255,255,255,0.78)" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
}

const base = { schema: 2 as const, asOf: null, partial: false }

export interface Fixture {
  id: string
  name: string
  card: CardV2
  /** What GIDEON has said so far, to see what lights up. */
  spoken?: string
}

const pictures: CardPicture[] = [
  ['#c98a5a', '#3a2418', 'I'],
  ['#8a5a3a', '#241410', 'II'],
  ['#d8b48a', '#5a3a28', 'III'],
  ['#6a4a3a', '#1a120e', 'IV'],
  ['#b0784a', '#3a2214', 'V'],
  ['#e0c49a', '#6a4a30', 'VI'],
].map(([from, to, label], index) => ({
  url: svg(1600, 1100, from, to, label),
  thumb: svg(720, 500, from, to, label),
  alt: `Sample picture ${index + 1}`,
  pageUrl: 'https://www.pexels.com/',
  host: 'pexels.com',
}))

/** When the lab pretends it is, so a card's "latest figures" note reads as it did on the day. */
const LAB_NOW = Date.UTC(2026, 8, 14)

/** A card drawn from real materials by the code a conversation uses; the lab has no network, so a portrait is drawn in. */
function drawn(id: string, name: string, question: string, materials: Material[], spoken: string, portrait?: string): Fixture {
  const card = cardFromMaterials(question, materials, LAB_NOW)
  if (!card) throw new Error(`the lab's materials for ${name} draw no card`)
  const blocks: Block[] = portrait
    ? [{ id: 'media', slot: 'media', type: 'media', image: { url: svg(640, 800, '#5a5048', '#1c1a1a', portrait), alt: card.title, credit: 'Wikipedia' } }, ...card.blocks]
    : card.blocks
  return { id, name, spoken, card: { ...card, blocks } }
}

const HOUR = 3_600_000

/**
 * Map cards need Mapbox's public token to draw at all, from
 * VITE_MAPBOX_PUBLIC_TOKEN in .env; without it the lab leaves them out. The
 * places are real and their pins where the geocoder put them. The route's line
 * and figures are samples, drawn by hand along the motorway, and say so.
 */
// Read only while developing, so a production build never carries the token in the lab's code.
const MAPBOX = import.meta.env.DEV ? (import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN?.trim() ?? '') : ''
const LISBON_PIN: MapPlace = { name: 'Lisbon', detail: 'Portugal', kind: 'capital', at: [-9.1333, 38.7167], timezone: 'Europe/Lisbon' }
const PORTO_PIN: MapPlace = { name: 'Porto', detail: 'Portugal', kind: 'city', at: [-8.611, 41.1496], timezone: 'Europe/Lisbon' }

/** The weather for where the user is, as it is drawn when maps are set up: with the place's map. */
function weatherWithMap(): Fixture[] {
  if (!MAPBOX) return []
  const here = drawn('lab:weather-map', 'weather, with its map (Open-Meteo, Mapbox)', "What's the weather like here?", [WEATHER_LISBON], 'Sunny in Lisbon, 24 degrees.')
  return [{ ...here, card: withPlaceMap(here.card, WEATHER_LISBON.place, MAPBOX) }]
}

function mapFixtures(): Fixture[] {
  if (!MAPBOX) return []
  const place = placeCard({ question: 'Where is Lisbon?', place: LISBON_PIN, publicToken: MAPBOX, weatherNow: '24°C, sunny', now: LAB_NOW })
  const region = placeCard({
    question: 'Where is Tuscany?',
    place: { name: 'Tuscany', detail: 'Italy', kind: 'region', at: [11.2558, 43.7711], bounds: [9.6867, 42.3167, 12.3684, 44.4727] },
    publicToken: MAPBOX,
    now: LAB_NOW,
  })
  const route = routeCard({
    question: 'How long is it from Lisbon to Porto?',
    from: LISBON_PIN,
    to: PORTO_PIN,
    travel: 'driving',
    route: {
      seconds: 10_740,
      metres: 312_400,
      line: [[-9.1333, 38.7167], [-9.05, 38.85], [-8.95, 39.2], [-8.7, 39.6], [-8.55, 40.0], [-8.45, 40.4], [-8.55, 40.8], [-8.611, 41.1496]],
      steps: ['Drive north on Avenida da Liberdade.', 'Take the A1 towards Porto.', 'Keep on the A1 for 290 km.', 'Take exit 20 towards Porto centre.'],
    },
    publicToken: MAPBOX,
  })
  const sampled = {
    ...route,
    blocks: route.blocks.map((block) => (block.type === 'headline' ? { ...block, subtitle: 'Sample route and figures' } : block)),
  }
  return [
    { id: 'lab:map-place', name: 'map, a place (Mapbox)', card: place, spoken: 'Lisbon is on the Atlantic coast of Portugal, where the Tagus meets the sea.' },
    { id: 'lab:map-region', name: 'map, a region framed by its extent (Mapbox)', card: region },
    { id: 'lab:map-route', name: 'map, a route (sample figures)', card: sampled, spoken: 'About three hours to Porto by car, mostly on the A1.' },
  ]
}

/**
 * A front page of invented stories, so the lab never shows a real event as if
 * it were today's news. Their times are counted back from when the lab opens,
 * so the datelines read as they would on the day; the last knows only its date.
 */
const SAMPLE_NEWS: StoriesMaterial = {
  id: 'news:headlines:day',
  kind: 'stories',
  topic: '',
  since: 'day',
  items: [
    {
      headline: 'Night ferries return to the harbour after a decade away',
      deck: 'The harbour ferries will run until midnight from next month, restoring a service cut ten years ago as passenger numbers climb back to where they were.',
      url: 'https://harbour.example/night-ferries',
      host: 'harbour.example',
      published: new Date(Date.now() - 2 * HOUR).toISOString(),
      image: svg(1600, 900, '#2a4a6a', '#0e1822', 'Sample'),
      outlets: 5,
    },
    {
      headline: 'City library opens its reading room around the clock',
      deck: 'The main reading room will stay open through the night for a trial year, after students asked for somewhere quiet to work outside office hours.',
      url: 'https://library.example/reading-room',
      host: 'library.example',
      published: new Date(Date.now() - 5 * HOUR).toISOString(),
      outlets: 3,
    },
    {
      headline: 'Orchestra announces a free open-air season in the park',
      deck: 'Twelve evening concerts will be played on the lawn by the lake, and the first programme, of film music, was chosen by a public vote.',
      url: 'https://orchestra.example/open-air',
      host: 'orchestra.example',
      published: new Date(Date.now() - 27 * HOUR).toISOString(),
      outlets: 2,
    },
    {
      headline: "Botanic garden's giant water lily flowers for the first time",
      deck: 'Grown from seed in the glasshouse six years ago, the lily opened its first flower overnight, and will turn from white to pink by the morning.',
      url: 'https://garden.example/water-lily',
      host: 'garden.example',
      published: new Date(Date.now() - 50 * HOUR).toISOString().slice(0, 10),
      outlets: 1,
    },
    {
      headline: 'Cycle lane along the river opens a year early',
      deck: 'The six-kilometre lane links the old town to the university, and was finished ahead of time after a dry spring let crews work through the weekends.',
      url: 'https://transport.example/river-lane',
      host: 'transport.example',
      published: new Date(Date.now() - 30 * HOUR).toISOString(),
      outlets: 1,
    },
    {
      headline: 'Bakers revive a medieval loaf for the harvest fair',
      deck: 'Working from a recipe found in the town archive, three bakeries will sell the rye and honey loaf at the fair, which opens on Saturday morning.',
      url: 'https://fair.example/medieval-loaf',
      host: 'fair.example',
      published: new Date(Date.now() - 9 * HOUR).toISOString(),
      outlets: 1,
    },
  ],
  source: { title: 'News', url: 'https://harbour.example/night-ferries', fetchedAt: '2026-09-14T09:00:00.000Z' },
}

export const FIXTURES: Fixture[] = [
  drawn('lab:weather-dry', 'weather, dry (Open-Meteo)', "What's the weather in Lisbon?", [WEATHER_LISBON], 'Sunny and 24 degrees, with a high of 27, and tomorrow is a touch cooler.'),
  ...weatherWithMap(),
  drawn('lab:weather-wet', 'weather, wet (Open-Meteo)', 'Will it rain in Bergen this week?', [WEATHER_BERGEN], 'Rain every day this week, and Sunday looks the coldest.'),
  ...mapFixtures(),
  drawn('lab:front-page', 'front page (sample stories)', "What's in the news today?", [SAMPLE_NEWS], 'Night ferries are coming back to the harbour after ten years.'),
  drawn('lab:data-trend', 'trend from World Bank figures', 'How has the population of Japan changed?', [POPULATION_JPN], 'It peaked at about 128 million in 2010.'),
  drawn('lab:data-compare', 'three countries on one chart', 'Compare the populations of Japan, South Korea and China', [
    POPULATION_JPN,
    POPULATION_KOR,
    POPULATION_CHN,
  ], 'China is far larger than the other two.'),
  drawn('lab:data-years', 'a measure in years', 'How long do people live in Japan?', [LIFE_EXPECTANCY_JPN], 'About 84 years, up from under 68 in 1960.'),
  drawn('lab:data-profile', 'profile from a Wikidata record', 'Who was Marie Curie?', [MARIE_CURIE], 'She won the Nobel Prize in Physics in 1903.', 'M·C'),
  drawn('lab:data-cities', 'two records compared', 'Compare Lisbon and Porto', [LISBON, PORTO], 'Lisbon has more than twice the population.'),
  {
    id: 'lab:profile',
    name: 'profile',
    spoken: 'She won the Nobel Prize in Physics in 1903, and another in Chemistry in 1911.',
    card: {
      ...base,
      recipe: 'profile',
      size: 'standard',
      query: 'Who was Marie Curie?',
      title: 'Marie Curie',
      blocks: [
        {
          id: 'media',
          slot: 'media',
          type: 'media',
          image: { url: svg(640, 800, '#5a5048', '#1c1a1a', 'M·C'), alt: 'Marie Curie', credit: 'Wikipedia' },
        },
        { id: 'headline', slot: 'body', type: 'headline', title: 'Marie Curie', subtitle: 'Physicist and chemist' },
        {
          id: 'summary',
          slot: 'body',
          type: 'prose',
          paragraphs: ['The first person to win two Nobel Prizes, for work on radioactivity.'],
        },
        {
          id: 'facts',
          slot: 'body',
          type: 'facts',
          items: [
            { label: 'Born', value: '7 November 1867, Warsaw' },
            { label: 'Died', value: '4 July 1934' },
            { label: 'Discovered', value: 'Polonium and radium' },
            { label: 'Nobel Prizes', value: 'Physics 1903, Chemistry 1911' },
          ],
        },
      ],
      sources: [
        { title: 'Marie Curie, facts', url: 'https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/', host: 'nobelprize.org' },
      ],
    },
  },
  {
    id: 'lab:figure',
    name: 'figure',
    card: {
      ...base,
      recipe: 'figure',
      size: 'standard',
      query: 'How far away is the Moon?',
      title: 'Distance to the Moon',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Distance to the Moon' },
        { id: 'stat', slot: 'body', type: 'stat', value: '384,400 km', label: 'Average distance' },
        { id: 'summary', slot: 'body', type: 'prose', paragraphs: ['Measured from the centre of the Earth to the centre of the Moon.'] },
        { id: 'facts', slot: 'body', type: 'facts', items: [{ label: 'Light takes', value: 'About 1.3 seconds' }] },
      ],
      sources: [{ title: 'NASA: Moon facts', url: 'https://science.nasa.gov/moon/facts/', host: 'science.nasa.gov' }],
    },
  },
  {
    id: 'lab:news',
    name: 'news (sample story)',
    card: {
      ...base,
      recipe: 'news',
      size: 'standard',
      query: 'harbour ferries',
      title: 'Night ferries return to the harbour',
      blocks: [
        {
          id: 'media',
          slot: 'media',
          type: 'media',
          image: { url: svg(1600, 800, '#2a4a6a', '#0e1822', 'Sample'), alt: 'The harbour at night', credit: 'example.org' },
        },
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Sample · 13 September 2026', title: 'Night ferries return to the harbour' },
        { id: 'summary', slot: 'body', type: 'prose', paragraphs: ['A sample story, for judging the layout: the service resumes on Monday.'] },
        { id: 'facts', slot: 'body', type: 'facts', items: [{ label: 'From', value: 'Monday' }] },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/ferries', host: 'example.org' }],
    },
  },
  {
    id: 'lab:answer',
    name: 'answer',
    card: {
      ...base,
      recipe: 'answer',
      size: 'standard',
      query: 'Why is the sky blue?',
      title: 'Why the sky is blue',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Why the sky is blue' },
        {
          id: 'summary',
          slot: 'body',
          type: 'prose',
          paragraphs: ['Air scatters short blue wavelengths of sunlight far more than long red ones, so blue reaches the eye from every part of the sky.'],
        },
        { id: 'facts', slot: 'body', type: 'facts', items: [{ label: 'Effect', value: 'Rayleigh scattering' }, { label: 'At sunset', value: 'Light crosses more air, so red dominates' }] },
      ],
      sources: [{ title: 'Met Office', url: 'https://weather.metoffice.gov.uk/learn-about/weather/optical-effects/why-is-the-sky-blue', host: 'metoffice.gov.uk' }],
    },
  },
  {
    id: 'lab:compare',
    name: 'compare (sample values)',
    spoken: 'Porto sits on the Douro.',
    card: {
      ...base,
      recipe: 'compare',
      size: 'wide',
      query: 'Compare Lisbon and Porto',
      title: 'Lisbon and Porto',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Compare', title: 'Lisbon and Porto' },
        {
          id: 'table',
          slot: 'body',
          type: 'table',
          rowHeaders: true,
          columns: [
            { key: 'attribute', label: 'Sample values', kind: 'text' },
            { key: 'lisbon', label: 'Lisbon', kind: 'text' },
            { key: 'porto', label: 'Porto', kind: 'text' },
          ],
          rows: [
            { id: 'population', cells: [{ text: 'City population' }, { text: '545 k' }, { text: '232 k' }] },
            { id: 'river', cells: [{ text: 'River' }, { text: 'Tagus' }, { text: 'Douro' }] },
            { id: 'airport', cells: [{ text: 'Airport' }, { text: 'LIS' }, { text: 'OPO' }] },
            { id: 'known', cells: [{ text: 'Known for' }, { text: 'Trams, fado' }, { text: 'Port wine' }] },
          ],
        },
        { id: 'note', slot: 'body', type: 'note', tone: 'info', text: 'Populations are for the cities themselves, not their metropolitan areas.' },
        {
          id: 'chips',
          slot: 'body',
          type: 'chips',
          items: [
            { label: 'How far apart are they?', ask: 'How far is Porto from Lisbon?' },
            { label: 'Weather this weekend', ask: 'What is the weather in Lisbon and Porto this weekend?' },
          ],
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/cities', host: 'example.org' }],
    },
  },
  {
    id: 'lab:ranking',
    name: 'ranking table (sample values)',
    card: {
      ...base,
      recipe: 'ranking',
      size: 'wide',
      query: 'busiest harbour ferry routes',
      title: 'Busiest ferry routes',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Sample values', title: 'Busiest ferry routes' },
        {
          id: 'table',
          slot: 'body',
          type: 'table',
          caption: 'Passengers a year, sample figures for judging the layout',
          columns: [
            { key: 'route', label: 'Route', kind: 'text' },
            { key: 'passengers', label: 'Passengers', kind: 'number', unit: 'millions' },
            { key: 'minutes', label: 'Crossing', kind: 'number', unit: 'min' },
          ],
          rows: [
            ['Harbour to Old Market', 4.9, 12],
            ['North Quay to Island', 3.2, 25],
            ['Station to Lighthouse', 2.6, 18],
            ['Bridge Steps to Beach', 1.4, 9],
            ['Castle to Shipyard', 0.8, 31],
          ].map(([route, passengers, minutes]) => ({
            id: String(route),
            cells: [
              { text: String(route) },
              { text: String(passengers), value: Number(passengers) },
              { text: String(minutes), value: Number(minutes) },
            ],
          })),
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/ferries', host: 'example.org' }],
    },
  },
  {
    id: 'lab:trend',
    name: 'figure that moved (sample series)',
    card: {
      ...base,
      recipe: 'trend',
      size: 'standard',
      query: 'harbour ferry passengers',
      title: 'Harbour ferry passengers',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Harbour ferry passengers', subtitle: 'Per year, sample series' },
        {
          id: 'stat',
          slot: 'body',
          type: 'stat',
          value: '4.9 M',
          label: 'Latest year',
          change: { value: '+58%', direction: 'up', period: 'since 2014', formula: '(4.9 − 3.1) ÷ 3.1' },
          spark: [3.1, 3.3, 3.6, 3.9, 4.2, 4.4, 1.9, 2.6, 3.5, 4.1, 4.5, 4.9],
        },
        { id: 'note', slot: 'body', type: 'note', tone: 'stale', text: 'Sample figures; the latest year is 2025.' },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/ferries', host: 'example.org' }],
    },
  },
  {
    id: 'lab:timeline',
    name: 'timeline',
    spoken: 'In 1903 she shared the Nobel Prize in Physics.',
    card: {
      ...base,
      recipe: 'timeline',
      size: 'wide',
      query: 'Marie Curie timeline',
      title: 'Marie Curie',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Timeline', title: 'Marie Curie', subtitle: 'Physicist and chemist' },
        {
          id: 'timeline',
          slot: 'body',
          type: 'timeline',
          events: [
            { id: 'born', date: '1867', label: 'Born in Warsaw' },
            { id: 'paris', date: '1891', label: 'Moves to Paris' },
            { id: 'radium', date: '1898', label: 'Polonium and radium' },
            { id: 'physics', date: '1903', label: 'Nobel Prize in Physics' },
            { id: 'chemistry', date: '1911', label: 'Nobel Prize in Chemistry' },
            { id: 'died', date: '1934', label: 'Dies' },
          ],
        },
        {
          id: 'list',
          slot: 'body',
          type: 'list',
          ordered: false,
          items: [
            { id: 'nobel', title: 'Marie Curie, facts', meta: 'nobelprize.org', url: 'https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/' },
          ],
        },
      ],
      sources: [{ title: 'The Nobel Prize', url: 'https://www.nobelprize.org/prizes/physics/1903/marie-curie/facts/', host: 'nobelprize.org' }],
    },
  },
  {
    id: 'lab:steps',
    name: 'steps',
    card: {
      ...base,
      recipe: 'steps',
      size: 'standard',
      query: 'How do I tie a bowline?',
      title: 'Tying a bowline',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Tying a bowline', subtitle: 'A fixed loop that will not slip' },
        {
          id: 'steps',
          slot: 'body',
          type: 'steps',
          items: [
            'Make a small loop in the standing part of the rope.',
            'Pass the working end up through the loop from underneath.',
            'Take the end around behind the standing part.',
            'Bring it back down through the small loop.',
            'Hold the end and pull the standing part to tighten.',
          ],
        },
        { id: 'quote', slot: 'body', type: 'quote', text: 'The rabbit comes out of the hole, round the tree, and back down the hole.', who: 'How it is usually taught' },
      ],
      sources: [{ title: 'Animated Knots', url: 'https://www.animatedknots.com/bowline-knot', host: 'animatedknots.com' }],
    },
  },
  {
    id: 'lab:chart-line',
    name: 'line chart (sample series)',
    card: {
      ...base,
      recipe: 'trend',
      size: 'wide',
      query: 'harbour ferry passengers over time',
      title: 'Harbour ferry passengers',
      blocks: [
        { id: 'headline', slot: 'head', type: 'headline', kicker: 'Trend', title: 'Harbour ferry passengers' },
        {
          id: 'stat',
          slot: 'figure',
          type: 'stat',
          value: '4.9 M',
          label: 'In 2025',
          change: { value: '+58%', direction: 'up', period: 'since 2014', formula: '(4.9 − 3.1) ÷ 3.1' },
        },
        {
          id: 'chart',
          slot: 'data',
          type: 'chart',
          form: 'line',
          title: 'Passengers a year',
          unit: 'M',
          xLabel: 'Year',
          asOf: 'Sample series',
          x: ['2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'],
          series: [{ key: 'ferry', label: 'Ferry', values: [3.1, 3.3, 3.6, 3.9, 4.2, 4.4, 1.9, 2.6, 3.5, 4.1, 4.5, 4.9] }],
          marks: [{ at: 6, label: 'Low' }],
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/ferries', host: 'example.org' }],
    },
  },
  {
    id: 'lab:chart-lines',
    name: 'two lines with a gap (sample series)',
    card: {
      ...base,
      recipe: 'trend',
      size: 'wide',
      query: 'ferry and tram passengers',
      title: 'Ferry and tram',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Ferry and tram' },
        {
          id: 'chart',
          slot: 'body',
          type: 'chart',
          form: 'line',
          title: 'Passengers a year',
          unit: 'M',
          xLabel: 'Year',
          x: ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'],
          series: [
            { key: 'ferry', label: 'Ferry', values: [4.2, 4.4, 1.9, 2.6, 3.5, 4.1, 4.5, 4.9] },
            { key: 'tram', label: 'Tram', values: [6.1, 6.4, null, 3.8, 5.2, 5.9, 6.3, 6.6] },
          ],
        },
        { id: 'note', slot: 'body', type: 'note', tone: 'info', text: 'Sample series. The tram did not report for 2020.' },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/transit', host: 'example.org' }],
    },
  },
  {
    id: 'lab:chart-column',
    name: 'columns (sample forecast)',
    card: {
      ...base,
      recipe: 'figure',
      size: 'standard',
      query: 'will it rain this week',
      title: 'Chance of rain',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'Chance of rain', subtitle: 'Sample forecast' },
        {
          id: 'chart',
          slot: 'body',
          type: 'chart',
          form: 'column',
          title: 'Chance of rain',
          unit: '%',
          xLabel: 'Day',
          x: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
          series: [{ key: 'rain', label: 'Rain', values: [5, 10, 40, 70, 35, 10, 0] }],
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/forecast', host: 'example.org' }],
    },
  },
  {
    id: 'lab:chart-bar',
    name: 'ranked bars (sample values)',
    card: {
      ...base,
      recipe: 'ranking',
      size: 'wide',
      query: 'busiest ferry routes',
      title: 'Busiest ferry routes',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Ranking', title: 'Busiest ferry routes' },
        {
          id: 'chart',
          slot: 'body',
          type: 'chart',
          form: 'bar',
          title: 'Passengers a year',
          unit: 'M',
          xLabel: 'Route',
          summary: 'Sample values: the harbour route carries the most, 4.9 M a year.',
          x: ['Harbour to Old Market', 'North Quay to Island', 'Station to Lighthouse', 'Bridge Steps to Beach', 'Castle to Shipyard'],
          series: [{ key: 'passengers', label: 'Passengers', values: [4.9, 3.2, 2.6, 1.4, 0.8] }],
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/ferries', host: 'example.org' }],
    },
  },
  {
    id: 'lab:chart-range',
    name: 'temperature ranges (sample forecast)',
    card: {
      ...base,
      recipe: 'weather',
      size: 'wide',
      query: 'weather this week',
      title: 'The week',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', title: 'The week', subtitle: 'Sample forecast' },
        {
          id: 'chart',
          slot: 'body',
          type: 'chart',
          form: 'range',
          title: 'Low and high',
          unit: '°C',
          xLabel: 'Day',
          x: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
          series: [
            { key: 'low', label: 'Low', values: [18, 17, 16, 15, 16, 17, 18] },
            { key: 'high', label: 'High', values: [27, 25, 24, 22, 23, 26, 28] },
          ],
        },
      ],
      sources: [{ title: 'Sample source', url: 'https://example.org/forecast', host: 'example.org' }],
    },
  },
  {
    id: 'lab:gallery',
    name: 'gallery',
    card: {
      ...base,
      recipe: 'gallery',
      size: 'standard',
      query: 'chocolate cake',
      title: 'Chocolate cake',
      blocks: [
        { id: 'headline', slot: 'body', type: 'headline', kicker: 'Pictures', title: 'Chocolate cake' },
        { id: 'gallery', slot: 'body', type: 'gallery', pictures },
      ],
      sources: [{ title: 'Pexels', url: 'https://www.pexels.com/', host: 'pexels.com' }],
    },
  },
]
