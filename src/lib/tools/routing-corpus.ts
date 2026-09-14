/**
 * Sentences a person might say, and the tool each should reach for, or none.
 *
 * The corpus is the definition of routing that the speaking model is measured
 * against (`npm run benchmark:routing`). A case records what is right for the
 * product, not what the model happens to do today: when the two disagree, the
 * description or the prompt is what changes.
 *
 * Groups: plain requests for each tool; both sides of every pair of tools that
 * could be confused, as close as a sentence can get to the other side; figures
 * of speech and small talk that need no tool, several of them built to tempt
 * one; commands and questions about the cards already on screen; and two
 * requests in one sentence. No case repeats an example from a skill manifest
 * or from the speaking model's prompt.
 */

import type { ScreenState } from '../stage-judge'
import type { ToolName } from './skills'

export type RoutingGroup = 'plain' | 'boundary' | 'speech' | 'screen' | 'double'

export interface RoutingCase {
  say: string
  /** Every tool the turn should call, in any order. Empty when none should be. */
  expect: ToolName[]
  /** Tools that would not be wrong beside the expected ones: a harmless lookup the answer did not need. */
  accept?: ToolName[]
  group: RoutingGroup
  /** With the cards below on screen. */
  screen?: boolean
  /** For a boundary case: what makes it this side of the line. */
  why?: string
}

/** Two cards, the population of Japan in front, for the cases about what is on screen. */
export const ROUTING_SCREEN: ScreenState = {
  open: true,
  front: 'japan',
  cards: [
    {
      id: 'curie',
      title: 'Marie Curie',
      query: 'who was Marie Curie',
      kind: 'profile',
    },
    {
      id: 'japan',
      title: 'Population, Japan',
      query: "how has Japan's population changed since 1960",
      kind: 'trend',
      digest:
        'Population: 123.4 million, −3.7% since 2010. Chart of population: Japan 93.2 million in 1960, 123.4 million in 2025, highest 128.1 million in 2010',
    },
  ],
}

const plain = (say: string, tool: ToolName, accept?: ToolName[]): RoutingCase => ({ say, expect: [tool], group: 'plain', ...(accept ? { accept } : {}) })
const none = (say: string, group: RoutingGroup = 'speech', accept?: ToolName[]): RoutingCase => ({ say, expect: [], group, ...(accept ? { accept } : {}) })
const boundary = (say: string, tool: ToolName | null, why: string, accept?: ToolName[]): RoutingCase => ({
  say,
  expect: tool ? [tool] : [],
  group: 'boundary',
  why,
  ...(accept ? { accept } : {}),
})
const onScreen = (say: string): RoutingCase => ({ say, expect: [], group: 'screen', screen: true })
const double = (say: string, tools: ToolName[], accept?: ToolName[]): RoutingCase => ({ say, expect: tools, group: 'double', ...(accept ? { accept } : {}) })

export const ROUTING_CORPUS: RoutingCase[] = [
  // -- research ---------------------------------------------------------------------
  plain('who won the last Champions League final', 'research'),
  plain("what's the population of Brazil", 'research'),
  plain('how has the price of gold changed this year', 'research'),
  plain("what's happening in the news today", 'research'),
  plain('who is the prime minister of Japan right now', 'research'),
  plain('what is the James Webb Space Telescope', 'research'),
  plain("what's the score in the Arsenal game", 'research'),
  plain('when does the next iPhone come out', 'research'),
  plain('tell me about the Great Wall of China', 'research'),
  plain('who was Ada Lovelace', 'research'),
  plain('compare Python and Rust', 'research'),
  plain('how much does a Tesla Model 3 cost', 'research'),
  plain("what's the exchange rate from pounds to euros", 'research'),
  plain('is it going to rain in Manchester tomorrow', 'research'),
  plain('look up the opening hours of the British Museum', 'research'),
  plain('what are the newest AI models out this month', 'research'),
  plain("what's the tallest building in the world", 'research'),
  plain('how many people live in Tokyo', 'research'),
  plain('where is Machu Picchu', 'research'),
  plain('can you check whether the M25 is closed today', 'research'),

  // -- show_images ------------------------------------------------------------------
  plain('show me pictures of red pandas', 'show_images'),
  plain('what does a pangolin look like', 'show_images'),
  plain('can I see some photos of Scandinavian kitchens', 'show_images'),
  plain('show me the northern lights', 'show_images'),
  plain('images of art deco buildings in Miami', 'show_images'),
  plain('what do Japanese maples look like in autumn', 'show_images'),
  plain('show me Lisbon', 'show_images'),
  plain('pictures of lemon tarts please', 'show_images'),
  plain('let me see what the new Porsche 911 looks like', 'show_images'),
  plain('show me some mid-century modern living rooms', 'show_images'),
  plain('photos of snow leopards', 'show_images'),
  plain('what does the inside of the Sagrada Familia look like', 'show_images'),

  // -- memory -----------------------------------------------------------------------
  plain("remember that my sister's name is Aisha", 'remember'),
  plain("I'm vegetarian, keep that in mind", 'remember'),
  plain('just so you know, I work night shifts at the hospital', 'remember'),
  plain("my daughter starts school next Monday, don't let me forget", 'remember'),
  plain("do you remember my sister's name", 'recall'),
  plain('what did I tell you about my diet', 'recall'),
  plain("what's my dog called again", 'recall'),
  plain("what's my partner's name", 'recall'),
  plain('did I tell you where I work', 'recall'),
  plain('remind me what my goals for this year were', 'recall'),
  plain('what do you know about me', 'recall'),
  plain('which football team do I support', 'recall'),
  plain('forget what I told you about my job', 'forget'),
  plain('please delete everything you know about my sister', 'forget'),
  plain('stop remembering my address', 'forget'),
  plain('wipe my phone number from your memory', 'forget'),

  // -- set_timer --------------------------------------------------------------------
  plain('set a timer for ten minutes', 'set_timer'),
  plain('remind me in twenty minutes to take the bread out', 'set_timer'),
  plain('timer for 45 seconds', 'set_timer'),
  plain('give me a shout in an hour so I can stretch', 'set_timer'),
  plain('can you set a five minute timer for the tea', 'set_timer'),
  plain('wake me up in half an hour', 'set_timer'),

  // -- offer_link: finding the address first is not wrong ---------------------------
  plain('give me a link to the BBC News website', 'offer_link', ['research']),
  plain("send me the link to Wikipedia's page on octopuses", 'offer_link', ['research']),
  plain('open the Python documentation for me', 'offer_link', ['research']),
  plain('I want to book a train, give me the National Rail site', 'offer_link', ['research']),

  // -- the time: the model is told it every turn, and checking is harmless ----------
  none('what time is it', 'plain', ['get_time']),
  none("what's the date today", 'plain', ['get_time']),
  none('how many days until Christmas', 'plain', ['get_time']),

  // -- boundaries -------------------------------------------------------------------
  boundary('show me the Sydney Opera House', 'show_images', 'asked to be shown a place'),
  boundary('who designed the Sydney Opera House', 'research', 'a fact about the place'),
  boundary('what does a blue whale look like', 'show_images', 'what it looks like'),
  boundary('how big is a blue whale', 'research', 'a fact about the animal'),
  boundary('photos of the Golden Gate Bridge', 'show_images', 'asked for photos'),
  boundary('when was the Golden Gate Bridge built', 'research', 'a date about the bridge'),
  boundary("my partner's birthday is on the 3rd of March", 'remember', 'a durable fact being told'),
  boundary("when is my partner's birthday", 'recall', 'a question about what was told'),
  boundary("I'm allergic to peanuts", 'remember', 'a durable fact being told'),
  boundary('am I allergic to anything', 'recall', 'a question about what was told'),
  boundary('remind me in ten minutes to check the oven', 'set_timer', 'a length of time from now'),
  boundary("keep in mind that I don't eat after 8pm", 'remember', 'a fact with no alert to set'),
  boundary("what's the square root of 144", null, 'a sum'),
  boundary("what's the population of Iceland", 'research', 'a figure about the world'),
  boundary('give me some tips for a job interview', null, 'advice'),
  boundary('which jobs are most in demand in the UK this year', 'research', 'current figures'),
  boundary("what's on the front page of the Guardian today", 'research', 'what a page says today'),
  boundary('link me to the Guardian', 'offer_link', 'asked for the link', ['research']),
  boundary('how long should I boil an egg', null, 'kitchen advice'),
  boundary('time my eggs for seven minutes', 'set_timer', 'a timer was asked for'),
  boundary('imagine a city made of glass', null, 'imagining, not seeing'),
  boundary('show me a city made of glass', 'show_images', 'asked to be shown'),
  boundary('what time does the sun set in Edinburgh today', 'research', 'a fact about a place today'),
  boundary('I forgot my umbrella again', null, 'forgot, not forget'),

  // -- figures of speech and small talk ---------------------------------------------
  none('picture this: a beach, no phones, just the sea'),
  none("I'm feeling a bit under the weather today"),
  none('can you map out my week with me'),
  none("time flies when you're having fun"),
  none('I need to remember to breathe'),
  none("forget it, it doesn't matter"),
  none("that's a picture-perfect idea"),
  none('good morning GIDEON'),
  none("thanks, that's really helpful"),
  none("you're funny"),
  none('tell me a story about a brave little toaster'),
  none("what should I do if I can't sleep"),
  none('do you think pineapple belongs on pizza'),
  none('let me think about it for a minute'),
  none('give me a second'),
  none("what's seventeen plus twenty five"),
  none('how do you spell necessary'),
  none('I had such a long day'),
  none('can you help me write a birthday message for my mum'),
  none('how do you say good night in Spanish'),

  // -- cards on screen --------------------------------------------------------------
  onScreen('go back to the Marie Curie card'),
  onScreen('put the cards away'),
  onScreen('close these'),
  onScreen('when did the population peak'),
  onScreen('what was it in 1960'),
  onScreen('show me the other card'),
  onScreen('bring the first one back'),
  onScreen('hide that for now'),
  onScreen('is it going up or down'),
  onScreen("that's enough for now, thanks"),
  onScreen('go back'),
  onScreen('tuck them away'),
  onScreen('which card is this'),
  onScreen('read me what the card says'),
  onScreen('can you make the chart bigger'),

  // -- two requests in one sentence -------------------------------------------------
  double('set a timer for ten minutes and remember that I like my tea strong', ['set_timer', 'remember']),
  double('show me pictures of Kyoto and tell me how many people live there', ['show_images', 'research']),
  double("what's the weather in Paris, and show me photos of the Louvre", ['research', 'show_images']),
  double('forget my old address and remember that I live in Leeds now', ['forget', 'remember']),
  double("look up when the Tate Modern closes and give me a link to its website", ['research', 'offer_link']),
  double('remind me in 15 minutes to call mum, and who won the snooker last night', ['set_timer', 'research']),
  double('show me pictures of puffins and remember that I love seabirds', ['show_images', 'remember']),
]
