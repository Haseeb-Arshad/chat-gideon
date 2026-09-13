/**
 * What each recipe is called, what it is about, and the sizes it may take.
 *
 * A recipe names a preferred size and the sizes it may shrink to, largest
 * first; the stage draws the largest that fits. The words here are read by
 * people (the shelf's label) and by a model (what the stage judge is told a
 * card is about), so they are plain and short.
 */

import type { CardSize, RecipeId } from './schema'

export interface Recipe {
  id: RecipeId
  /** On the shelf tab, under the card's title. */
  label: string
  /** For the stage judge: what a card made by this recipe is about. */
  about: string
  /** Largest first. The first is the size the recipe prefers. */
  sizes: readonly CardSize[]
}

const recipe = (id: RecipeId, label: string, about: string, sizes: readonly CardSize[]): Recipe => ({
  id,
  label,
  about,
  sizes,
})

export const RECIPES: Record<RecipeId, Recipe> = {
  answer: recipe('answer', 'Answer', 'an answer', ['standard']),
  profile: recipe('profile', 'Card', 'about a person, place or thing', ['standard']),
  figure: recipe('figure', 'Figure', 'a number', ['standard', 'glance']),
  news: recipe('news', 'News', 'a news story', ['standard']),
  gallery: recipe('gallery', 'Pictures', 'pictures', ['standard']),
  compare: recipe('compare', 'Compare', 'a comparison', ['wide', 'standard']),
  trend: recipe('trend', 'Trend', 'a number over time', ['wide', 'standard']),
  ranking: recipe('ranking', 'Ranking', 'a ranking', ['wide', 'standard']),
  timeline: recipe('timeline', 'Timeline', 'a timeline of events', ['wide', 'standard']),
  steps: recipe('steps', 'Steps', 'steps to follow', ['standard']),
  'front-page': recipe('front-page', 'Front page', 'the news', ['feature', 'wide']),
  feature: recipe('feature', 'Feature', 'a long read', ['feature', 'wide']),
  recipe: recipe('recipe', 'Recipe', 'a recipe', ['wide', 'standard']),
  place: recipe('place', 'Place', 'a place on a map', ['wide', 'standard']),
  route: recipe('route', 'Route', 'a route on a map', ['wide', 'standard']),
  nearby: recipe('nearby', 'Nearby', 'places nearby on a map', ['feature', 'wide']),
  weather: recipe('weather', 'Weather', 'the weather', ['feature', 'wide', 'standard']),
  market: recipe('market', 'Market', 'a price', ['wide', 'standard']),
  video: recipe('video', 'Video', 'a video', ['wide', 'standard']),
  memory: recipe('memory', 'Memory', 'what GIDEON remembers about the user', ['standard']),
  spread: recipe('spread', 'Spread', 'several things together', ['feature']),
}

export function isRecipeId(value: unknown): value is RecipeId {
  return typeof value === 'string' && Object.hasOwn(RECIPES, value)
}

/** The size a recipe prefers. */
export function preferredSize(id: RecipeId): CardSize {
  return RECIPES[id].sizes[0]
}
