import { describe, expect, it } from 'vitest'
import { cleanText, grounded, knownNumbers, numbersIn, parseCard } from './cards'

/**
 * A card is a model's words shown as fact, so the rule that matters is the
 * grounding one: a number the brief never stated does not reach the screen.
 */

const brief =
  'Albert Einstein was a theoretical physicist, born on 14 March 1879 in Ulm, who died on 18 April 1955 in Princeton. He won the 1921 Nobel Prize in Physics. A letter of his sold for $67,420.50.'

const context = {
  query: 'Who was Einstein?',
  brief,
  sources: [
    { title: 'Albert Einstein | Britannica', url: 'https://www.britannica.com/biography/Albert-Einstein' },
    { title: 'Duplicate', url: 'https://www.britannica.com/biography/Albert-Einstein' },
    { title: 'Not a page', url: 'javascript:alert(1)' },
  ],
}

describe('numbers', () => {
  it('normalises separators and ignores units', () => {
    expect(numbersIn('1,879 people at 17°C')).toEqual(['1879', '17'])
  })

  it('keeps numbers that are only next to each other apart', () => {
    expect(numbersIn('in 2023 42 people')).toEqual(['2023', '42'])
    expect(numbersIn('1879–1955')).toEqual(['1879', '1955'])
  })

  it('lets a card round, but never invent a decimal', () => {
    const known = knownNumbers(brief)
    expect(grounded('$67,420', known)).toBe(true)
    expect(grounded('$67,420.50', known)).toBe(true)
    expect(grounded('$67,420.99', known)).toBe(false)
    expect(grounded('1879–1955', known)).toBe(true)
    expect(grounded('born 1880', known)).toBe(false)
    expect(grounded('no numbers at all', known)).toBe(true)
  })
})

describe('cleanText', () => {
  it('drops markdown emphasis and links but keeps names that look like markup', () => {
    expect(cleanText('**Albert Einstein** see https://x.org', 80)).toBe('Albert Einstein see')
    expect(cleanText('C# and snake_case', 80)).toBe('C# and snake_case')
  })

  it('clips at a word', () => {
    const clipped = cleanText('The general theory of relativity and the photoelectric effect', 30)
    expect(clipped.length).toBeLessThanOrEqual(30)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clipped).not.toMatch(/\s…$/)
  })
})

describe('parseCard', () => {
  it('keeps what the brief supports and drops what it does not', () => {
    const parsed = parseCard(
      {
        show: true,
        kind: 'entity',
        title: 'Albert Einstein',
        subtitle: 'Theoretical physicist (1879–1955)',
        summary: 'Einstein was a theoretical physicist. He wrote 300 papers.',
        facts: [
          { label: 'Born', value: '14 March 1879, Ulm' },
          { label: 'Died', value: '18 April 1955, Princeton' },
          { label: 'Children', value: '3' },
          { label: 'born', value: 'Ulm' },
          { label: 'Nobel Prize', value: 'Physics, 1921' },
        ],
        subject: 'Albert Einstein',
      },
      context,
    )

    expect(parsed?.subject).toBe('Albert Einstein')
    const card = parsed!.card
    expect(card.kind).toBe('entity')
    expect(card.subtitle).toBe('Theoretical physicist (1879–1955)')
    // The invented sentence goes; the grounded one stays.
    expect(card.summary).toBe('Einstein was a theoretical physicist.')
    // "3 children" is in no source, and a repeated label is one fact.
    expect(card.facts.map((fact) => fact.label)).toEqual(['Born', 'Died', 'Nobel Prize'])
    expect(card.sources).toEqual([
      {
        title: 'Albert Einstein | Britannica',
        url: 'https://www.britannica.com/biography/Albert-Einstein',
        host: 'britannica.com',
      },
    ])
    expect(card.image).toBeNull()
  })

  it('shows nothing when the model declines or leaves too little', () => {
    expect(parseCard({ show: false, title: 'Einstein' }, context)).toBeNull()
    expect(parseCard({ kind: 'entity', summary: 'A physicist.' }, context)).toBeNull()
    expect(parseCard({ kind: 'answer', title: 'Einstein' }, context)).toBeNull()
    expect(parseCard('not an object', context)).toBeNull()
  })

  it('turns a figure without a number into an ordinary answer', () => {
    const card = parseCard(
      {
        kind: 'figure',
        title: 'Letter price',
        summary: 'A letter of his sold at auction.',
        figure: { value: 'a lot', label: 'Sale price' },
      },
      context,
    )!.card
    expect(card.kind).toBe('answer')
    expect(card.figure).toBeNull()
  })

  it('keeps a figure the brief states', () => {
    const card = parseCard(
      {
        kind: 'figure',
        title: 'Letter price',
        summary: 'A letter of his sold for $67,420.50.',
        figure: { value: '$67,420', label: 'Sale price' },
        facts: [{ label: 'Sale price', value: '$67,420' }],
      },
      context,
    )!.card
    expect(card.figure).toEqual({ value: '$67,420', label: 'Sale price' })
    // A fact that only repeats the figure is not a second fact.
    expect(card.facts).toEqual([])
  })

  it('only asks Wikipedia about an entity', () => {
    const parsed = parseCard(
      { kind: 'answer', title: 'Nobel Prize', summary: 'He won it in 1921.', subject: 'Nobel Prize' },
      context,
    )
    expect(parsed?.subject).toBe('')
  })
})
