/**
 * Whether GIDEON has said part of a card out loud yet.
 */

import { numbersIn } from './ground'
import type { CardFact } from './schema'

/**
 * Whether a fact has been said.
 *
 * A number is the surest sign: "born in 1879" is the fact whose value holds
 * 1879. Without one, most of the value's longer words have to have been said.
 */
export function factSpoken(fact: CardFact, spoken: string): boolean {
  if (!spoken) return false
  const numbers = numbersIn(fact.value)
  if (numbers.length) {
    const heard = new Set(numbersIn(spoken))
    return numbers.some((number) => heard.has(number))
  }
  const said = spoken.toLowerCase()
  const words = fact.value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3)
  if (!words.length) return false
  return words.filter((word) => said.includes(word)).length / words.length >= 0.6
}
