/**
 * What each tool the speaking model sees is for, and what it is never for.
 *
 * Every tool is a decision the speaking model makes with someone waiting, and
 * the one thing it has to go on is the tool's description. A description
 * written by hand says whatever its author thought of that day. One generated
 * from a manifest says the same things in the same order for every tool: its
 * one job, what to use it for, what never to use it for and which tool is for
 * that instead, and how to speak about what it returns. A skill cannot be added
 * without saying what it is not for.
 *
 * The examples are for the people reading this file, and for the corpus check,
 * which makes sure none of them is ever a routing case: a model that passes on
 * sentences it has been shown has only recognised them.
 */

export type ToolName = 'get_time' | 'remember' | 'recall' | 'forget' | 'research' | 'show_images' | 'weather' | 'set_timer' | 'offer_link'

export interface SkillManifest {
  tool: ToolName
  /** The one thing it does, in a sentence. */
  job: string
  /** Each finishes "Use it for …". */
  useWhen: string[]
  /** Each finishes "Never use it for …", with the tool that is for it, or null when no tool is. */
  neverFor: Array<{ when: string; use: ToolName | null }>
  /** How to call it, or how to speak about what it returns. */
  voice?: string
  /** Sentences it is right for. Never routing cases. */
  examples: string[]
  /** Sentences it is wrong for, with what is right. Never routing cases. */
  counterExamples: Array<{ text: string; use: ToolName | null }>
  /** It leaves something behind after the turn: a memory kept or removed, a timer running, a link offered. */
  sideEffects: boolean
}

export const SKILLS: Record<ToolName, SkillManifest> = {
  get_time: {
    tool: 'get_time',
    job: "The current date and time in the user's timezone.",
    useWhen: ['a conversation that has run long enough for the time you were given at the start of the turn to be out of date'],
    neverFor: [{ when: 'the time or the date when a turn begins, which you were already told', use: null }],
    examples: ['we have been talking for ages, what time is it now'],
    counterExamples: [{ text: 'what day of the week is it', use: null }],
    sideEffects: false,
  },
  remember: {
    tool: 'remember',
    job: 'Store one durable fact about the user so it survives into later sessions: a preference, a name, an ongoing plan.',
    useWhen: [
      'a lasting fact about themselves the user mentions, even in passing: an allergy, a diet, their work, the name of someone close to them, an ongoing plan',
      'anything about them the user asks you to remember or keep in mind',
      'a fact about them that has changed, with replaces naming the old one so it is not kept too',
    ],
    neverFor: [
      { when: 'passing chat, a figure of speech, how the user feels today, or anything they have asked you not to keep', use: null },
      { when: 'an alert a length of time from now, such as "in ten minutes"', use: 'set_timer' },
      { when: 'a question about something the user told you before', use: 'recall' },
    ],
    voice: 'Saying you will keep something in mind does not keep it: call this instead of saying so.',
    examples: ['my brother lives in Glasgow', 'keep in mind I take my coffee black', 'remember that I am training for a marathon in April'],
    counterExamples: [
      { text: 'remind me in five minutes to stir the soup', use: 'set_timer' },
      { text: 'what is my brother called', use: 'recall' },
    ],
    sideEffects: true,
  },
  recall: {
    tool: 'recall',
    job: 'Search what you already know about the user.',
    useWhen: [
      'any question about the user themselves, such as their allergies, their plans, their work or the people close to them, that the things you were already told about them do not answer',
      'an answer that depends on something the user told you before',
    ],
    neverFor: [
      { when: 'a new fact the user is telling you', use: 'remember' },
      { when: 'facts about the world', use: 'research' },
    ],
    voice: 'Never tell the user you do not know something about them without calling this first.',
    examples: ['what did I say my favourite film was', 'do you know where I work', 'which day is my dentist appointment'],
    counterExamples: [
      { text: 'my favourite film is Alien', use: 'remember' },
      { text: 'who directed Alien', use: 'research' },
    ],
    sideEffects: false,
  },
  forget: {
    tool: 'forget',
    job: 'Delete stored memories matching a description.',
    useWhen: ['whenever the user asks you to forget, delete, stop remembering or stop keeping something about them'],
    neverFor: [
      { when: 'a fact that has changed, which remember replaces', use: 'remember' },
      { when: 'a figure of speech about the conversation, such as "forget it"', use: null },
    ],
    examples: ['forget where I work', 'delete what you know about my ex', 'stop keeping my phone number'],
    counterExamples: [
      { text: 'never mind, forget it', use: null },
      { text: 'I forgot my keys again', use: null },
    ],
    sideEffects: true,
  },
  research: {
    tool: 'research',
    job: 'Hand a question about the world to the research desk, which searches the live web, reads sources, and returns a short brief with the answer, the facts with their dates, and the sources.',
    useWhen: [
      'anything current or anything you would otherwise be guessing at: news, prices, scores, releases, what is true today',
      'a fact about a particular person, place, creature, thing, organisation, work or event (who or what it is, where it is, when it happened, how big or old it is), even one you know well: what it finds is shown on screen as a card, and the card is part of the answer',
      'a comparison of particular things, such as two languages, products or cities',
      'whenever the user tells you to search, look something up or check',
    ],
    neverFor: [
      { when: 'the forecast, or the weather now, for a place', use: 'weather' },
      { when: 'pictures, photos, or what something looks like', use: 'show_images' },
      { when: 'something the user told you about themselves', use: 'recall' },
      { when: 'a question about a card already on screen that what it shows answers', use: null },
      { when: 'small talk, opinions, jokes, advice, sums, or the conversation itself', use: null },
    ],
    voice:
      'Pass the whole question in plain words with every detail the user gave. Relay the brief faithfully: keep its numbers and dates exactly, never add facts it does not contain, and if it says something could not be found, say so.',
    examples: ['who founded Patagonia', 'is the Elizabeth line running today', 'how much is a pint of milk in the UK now'],
    counterExamples: [
      { text: 'show me the mountains of Patagonia', use: 'show_images' },
      { text: 'what is nine squared', use: null },
    ],
    sideEffects: false,
  },
  show_images: {
    tool: 'show_images',
    job: "Put pictures on the user's screen: photos of a thing, a place, a person, an animal, food, a design or a style.",
    useWhen: [
      'whenever the user asks to see, or be shown, pictures, photos or images of something',
      'what something looks like, even when you could describe it: the pictures are the answer',
      '"show me" a thing or a place',
    ],
    neverFor: [
      { when: 'facts about the thing, such as who made it, where it is or how big it is', use: 'research' },
      { when: 'a scene the user asks you to picture or imagine, which is talk, not a request to see', use: null },
      { when: 'bringing back a card that is already on screen', use: null },
    ],
    voice:
      'Never answer a request for pictures with a link to an image search. The pictures appear on screen by themselves, so say one short, natural line about them and never describe them one by one.',
    examples: ['show me flamingos', 'what does a quokka look like', 'photos of brutalist libraries'],
    counterExamples: [
      { text: 'how tall is a flamingo', use: 'research' },
      { text: 'picture me on a beach right now', use: null },
    ],
    sideEffects: false,
  },
  weather: {
    tool: 'weather',
    job: 'The forecast, or the conditions now, for one place, today and for the six days after it.',
    useWhen: [
      'what the weather is or will be somewhere, now or on a day this week',
      'rain, snow, wind, temperature, the UV index, sunrise or sunset at a place, now or on a day this week',
      'whether to take a coat, an umbrella or sunscreen somewhere',
    ],
    neverFor: [
      { when: 'what a place is like in a season, or its climate', use: 'research' },
      { when: 'the weather on a day that has passed, or more than a week away', use: 'research' },
      { when: 'a figure of speech, such as "under the weather"', use: null },
    ],
    voice: 'The card shows the details: say the one or two things that matter, such as rain later or a cold night.',
    examples: ['will it rain in Lisbon tomorrow', 'how cold is it in Reykjavik tonight', 'do I need sunscreen in Seville this afternoon'],
    counterExamples: [
      { text: 'what is Lisbon like in April', use: 'research' },
      { text: 'I feel under the weather', use: null },
    ],
    sideEffects: false,
  },
  set_timer: {
    tool: 'set_timer',
    job: 'Set a timer that alerts the user when it finishes.',
    useWhen: ['a timer, or a reminder a length of time from now, such as "remind me in ten minutes"'],
    neverFor: [
      { when: 'a day or a date, such as "next Monday", which is a plan to keep rather than a timer', use: 'remember' },
      { when: 'a fact to keep with no length of time on it', use: 'remember' },
      { when: 'a figure of speech such as "give me a minute"', use: null },
    ],
    examples: ['timer for twelve minutes', 'remind me in an hour to move the car', 'let me know when three minutes are up'],
    counterExamples: [
      { text: 'hang on a second', use: null },
      { text: 'remember I park on level two', use: 'remember' },
    ],
    sideEffects: true,
  },
  offer_link: {
    tool: 'offer_link',
    job: 'Put a link in front of the user as something they can choose to open.',
    useWhen: ['a link, a website or a page the user asks for, or asks you to open'],
    neverFor: [
      { when: 'what a page says', use: 'research' },
      { when: 'pictures, instead of showing them', use: 'show_images' },
    ],
    voice: 'It is never opened for them, so say aloud what it is and let them decide.',
    examples: ['open the Met Office website', 'give me the link to Spotify', 'send me the Duolingo website'],
    counterExamples: [
      { text: "what's the forecast on the Met Office website", use: 'research' },
      { text: 'show me the Spotify logo', use: 'show_images' },
    ],
    sideEffects: true,
  },
}

/** The description the speaking model reads, in the same shape for every tool. */
export function describeSkill(skill: SkillManifest): string {
  const parts = [skill.job, `Use it for ${skill.useWhen.join('; ')}.`]
  if (skill.neverFor.length) {
    const never = skill.neverFor.map(({ when, use }) => `${when} (${use ? `use ${use}` : 'answer without a tool'})`)
    parts.push(`Never use it for ${never.join(', or ')}.`)
  }
  if (skill.voice) parts.push(skill.voice)
  return parts.join(' ')
}

/** The tools that leave something behind, which must never fire when they were not asked for. */
export const SIDE_EFFECT_TOOLS: ReadonlySet<ToolName> = new Set(
  Object.values(SKILLS)
    .filter((skill) => skill.sideEffects)
    .map((skill) => skill.tool),
)
