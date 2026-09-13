/**
 * The colours data is drawn in, and the arithmetic that keeps them readable.
 *
 * The room behind the cards is a shader that changes colour with the mood, so
 * a chart's colours cannot be judged against one background. They are judged
 * against a well, the darker surface inside the glass that tables and charts
 * sit on, composited over every mood the room can take. The room may change
 * colour; the data may not.
 */

export type Rgb = readonly [number, number, number]

/**
 * The eight series colours, in the only order they are ever handed out. A
 * ninth series is folded into "Other", never given a new colour. This order
 * passes colour-blind and normal-vision separation for neighbouring series,
 * and the first three pass for every pair, which is the limit for charts where
 * any two marks can touch.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const

/** Only for a colour that means good or bad, and always beside a word that says which. */
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' } as const

/** The well: this ink, laid over the glass at this opacity. */
export const WELL = { ink: [5, 7, 11] as Rgb, alpha: 0.74 }

/** The inks text is set in inside a well, each with the opacity it is used at. */
export const INKS = {
  primary: { hex: '#f6f8ff', alpha: 1 },
  secondary: { hex: '#e2e8f1', alpha: 0.8 },
  label: { hex: '#bfe9ff', alpha: 0.7 },
  muted: { hex: '#a9b1bd', alpha: 1 },
} as const

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)) as unknown as Rgb
}

/** `top` laid over `bottom` at `alpha`. */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((channel, index) => channel * alpha + bottom[index] * (1 - alpha)) as unknown as Rgb
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** The WCAG contrast ratio between two colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}
