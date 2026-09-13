/**
 * Cards for the lab: one for every recipe the stage can draw, filled the way
 * a real one is, so a layout can be judged without spending a search.
 *
 * Pictures are drawn in place as small SVGs, so the lab needs no network and
 * nothing in it can fail to load. Sample figures are marked as samples.
 */

import type { CardPicture, CardV2 } from '../lib/cards/schema'

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

export const FIXTURES: Fixture[] = [
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
