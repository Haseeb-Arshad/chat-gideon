import { describe, expect, it } from 'vitest'
import { PALETTES, type EyeEmotion } from '../mood'
import { INKS, SERIES, WELL, contrast, hexToRgb, over, type Rgb } from './palette'

/**
 * Data stays readable over every mood the room can take.
 *
 * The well a chart sits on is recomputed here from the room's own palettes,
 * the same way it was measured when its darkness was chosen: the blurred room
 * behind a card taken as a mood's body with 35% of its bright crest (a
 * deliberately bright case), the glass's own 5% of white over that, then the
 * well's ink at its opacity. A change to the room that would make a chart
 * unreadable fails here, instead of on a card.
 */

const toBytes = (color: readonly number[]): Rgb => color.map((channel) => channel * 255) as unknown as Rgb

function wellOver(mood: EyeEmotion, alpha = WELL.alpha): Rgb {
  const { body, crest } = PALETTES[mood]
  const backdrop = over(toBytes(crest), 0.35, toBytes(body))
  const glass = over([255, 255, 255], 0.05, backdrop)
  return over(WELL.ink, alpha, glass)
}

const moods = Object.keys(PALETTES) as EyeEmotion[]

describe('the well', () => {
  it('keeps every series colour at 3:1 or more, over every mood', () => {
    for (const mood of moods) {
      for (const color of SERIES) {
        expect(contrast(hexToRgb(color), wellOver(mood)), `${color} over ${mood}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps every text ink at 4.5:1 or more, over every mood', () => {
    for (const mood of moods) {
      const well = wellOver(mood)
      for (const [name, ink] of Object.entries(INKS)) {
        const text = over(hexToRgb(ink.hex), ink.alpha, well)
        expect(contrast(text, well), `${name} over ${mood}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('would not be dark enough at 60%, which is why it is not', () => {
    // The measured line: green over the warmest mood is the first to fail.
    expect(contrast(hexToRgb('#008300'), wellOver('happy', 0.6))).toBeLessThan(3)
  })
})
