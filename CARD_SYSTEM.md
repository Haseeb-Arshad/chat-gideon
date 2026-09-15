# The card system

> A plan, written on 13 September 2026, before any of it is built. It grows the
> research stage described in [RESEARCH_STAGE.md](RESEARCH_STAGE.md) from one
> kind of card into a system: cards in four sizes, built from blocks, holding
> tables, charts, timelines, maps, video and newspaper layouts, gathered by
> narrow skills that are tested against each other so the wrong one does not
> fire. Everything that makes today's card good is kept, and section 1 says
> exactly what that is.

## Contents

1. [What was asked for](#what-was-asked-for)
2. [What is kept, and what stops it growing](#what-is-kept-and-what-stops-it-growing)
3. [The rules every card obeys](#the-rules-every-card-obeys)
4. [Materials, blocks, recipes, skills, crafting](#materials-blocks-recipes-skills-crafting)
5. [Sizes](#sizes)
6. [Blocks](#blocks)
7. [Recipes](#recipes)
8. [Skills](#skills)
9. [Keeping the wrong skill from firing](#keeping-the-wrong-skill-from-firing)
10. [How a card is made](#how-a-card-is-made)
11. [The schema and the wire](#the-schema-and-the-wire)
12. [Liquid glass for dense content](#liquid-glass-for-dense-content)
13. [Charts and tables](#charts-and-tables)
14. [Maps](#maps)
15. [Video](#video)
16. [The front page and the feature](#the-front-page-and-the-feature)
17. [Weather and markets](#weather-and-markets)
18. [The screen as a workspace](#the-screen-as-a-workspace)
19. [Speaking in step with the screen](#speaking-in-step-with-the-screen)
20. [Security, privacy and licences](#security-privacy-and-licences)
21. [Performance budgets](#performance-budgets)
22. [Measuring it](#measuring-it)
23. [Phases](#phases)
24. [Decisions that are yours](#decisions-that-are-yours)
25. [Risks](#risks)
26. [Files](#files)
27. [Appendix A: a skill manifest](#appendix-a-a-skill-manifest)
28. [Appendix B: the routing corpus](#appendix-b-the-routing-corpus)
29. [Sources checked](#sources-checked)

---

## What was asked for

Each part of the request, and where this plan answers it.

| Asked for | Answered in |
| --- | --- |
| Cards in different sizes, not one | [Sizes](#sizes) |
| Tables, comparison graphs, charts, informative graphics | [Blocks](#blocks), [Charts and tables](#charts-and-tables) |
| Newspaper and magazine cards | [The front page and the feature](#the-front-page-and-the-feature) |
| More meaningful information, of more than one kind | [How a card is made](#how-a-card-is-made): cards drawn from everything the research saw, not only what it said |
| Mapbox maps | [Maps](#maps) |
| Intelligent, "like Minecraft, with crafts and informatics" | [Materials, blocks, recipes, skills, crafting](#materials-blocks-recipes-skills-crafting) and [The screen as a workspace](#the-screen-as-a-workspace) |
| Narrow skills, and never the wrong one | [Skills](#skills), [Keeping the wrong skill from firing](#keeping-the-wrong-skill-from-firing) |
| Video | [Video](#video) |
| Its own liquid UI, the same glass as the rest of the site | [Liquid glass for dense content](#liquid-glass-for-dense-content) |

Two readings are worth stating, because the plan is built on them.

- **"Like Minecraft"** is read as *crafting from blocks*. A card is not a
  template with blanks. It is made of small typed blocks (a chart, a table, a
  map pin, a stat), arranged by a named recipe, from materials a skill
  gathered. Cards already on screen are materials too, so two of them can be
  crafted into a third: two people into a comparison, three places onto one
  map, a price into its history.
- **"Skills"** is read as GIDEON's own abilities at runtime: narrow tools the
  speaking model and the research desk can call, each with one job and a
  written boundary. A contributor checklist for adding a new skill is in
  [Appendix A](#appendix-a-a-skill-manifest); it can become a repository skill
  file later if that is wanted.

## What is kept, and what stops it growing

### Kept

These are the reasons today's card works, and every new card inherits them.

- **The card never delays the voice.** It is drawn beside the spoken answer and
  released at the next frame the loop sends anyway (`drawing` and `release()` in
  `src/lib/agent-core.ts`).
- **No number reaches the screen that the brief did not state.** `grounded()`
  and `knownNumbers()` in `src/lib/cards.ts` remove an invented number together
  with whatever carried it.
- **"No card" is an answer.** An empty pane of glass says less than no pane.
- **Three layers per card** (place, float, glass), where only the innermost ever
  fades or blurs, and only the card in front refracts.
- **The choreography.** The face docks, the previous card peeks, the shelf
  holds, and the stage judge brings a card back when the talk returns to it.
- **Facts brighten as they are said** (`factSpoken()`).
- **A guess's cards wait with the guess** (`heldRef` in `AgentPage.tsx`).

### What stops it growing

1. **A card is one flat shape.** `Card` has a field for everything a card has
   ever needed (`figure`, `kicker`, `facts`, `image`, `pictures`) and `CardFace`
   branches on each. A table, a chart, a map and a video would each be one more
   field and one more branch, and no card could hold two of them.
2. **One size.** Every card is `min(700px, 100cqw - 160px)` wide, 960 at most on
   a wide screen. A comparison of four things or a year of prices does not fit,
   and a single number does not need it.
3. **A card can only show what the brief said in prose.** The brief is under 180
   words, 260 for a list. That is enough for five facts and not for a table,
   and a chart needs numbers nobody would read aloud.
4. **The model that lays the card out also writes its numbers.** Grounding
   catches invented ones by deleting them, which is safe and lossy: "delete what
   cannot be verified" leaves holes in a table of forty numbers.
5. **A card arrives whole or not at all.** The fast parts (a portrait, a pin,
   the temperature now) wait for the slowest.
6. **The speaking model knows a card only by its title**, so "which one is
   cheaper?" cannot be answered in step with what is on screen.
7. **Nothing on a card can be changed** except opening a picture. Nothing sorts,
   zooms, plays or switches view.
8. **The shelf does not survive a reload.**

## The rules every card obeys

1. **The voice never waits for the screen.** A skill hands the speaking model its
   words first. The card follows beside them.
2. **Nothing on screen that a source did not say.** Every value is copied from a
   source response, taken from the brief, or computed in code from those and
   labelled as computed.
3. **Values are referenced, never retyped.** The model composing a card names
   *where* a value is ("the last point of m2") and code copies it. A model cannot
   mistype a number it never writes.
4. **A card earns its size.** Size follows from how much real content there is,
   by rule: a chart needs enough points, a table enough filled cells, a map real
   coordinates. Short of that, the card steps down a size or a recipe, and "no
   card" is still the last step.
5. **One material.** Every surface is the same liquid glass. Dense content sits
   in a calmer well inside it, so legibility never depends on the colour of the
   room behind.
6. **Narrow skills with sharp edges.** A skill does one job, says what it is not
   for and which tool is, and is tested against the neighbours it could be
   mistaken for.
7. **Unobservable until real.** Data skills are read-only, so a speculative turn
   may run them. Nothing they produce is shown until the turn is kept.
8. **Measured before it ships.** Routing accuracy, grounding violations, time to
   card and frame size each have a benchmark and a gate, in the manner of
   `benchmark:research` and `benchmark:cards`.
9. **It degrades like the rest of GIDEON.** No Mapbox token: a place card without
   a live map. No WebGL: a still map. No video key: fewer details, same card. No
   key at all: the skill is not offered, as `research` is not offered without
   `EXA_API_KEY`.

## Materials, blocks, recipes, skills, crafting

| Term | What it is | Example |
| --- | --- | --- |
| **Material** | Evidence captured *by code* from a source's response, with where and when it came from. Never written by a model. | a World Bank series, a Wikidata record, a Mapbox route, dated search results |
| **Block** | The smallest thing on a card, with a typed data contract | a chart, a table, a timeline, a map, a stat |
| **Recipe** | A named arrangement of blocks, with the materials it needs and the recipe it falls back to | `trend` is a stat, a chart, facts and a note |
| **Skill** | A narrow capability that gathers materials and names the recipes it can make | `weather`, `show_map`, `research` |
| **Crafting** | A new card made from cards already on screen | two people into a comparison |
| **Spread** | Several cards' blocks laid out as one board | the weather: now, the next day, the week |

```text
skill ──gathers──► materials ──referenced by──► blocks ──arranged by──► recipe ──► card
                                                                                  │
card + card ──(their materials)──► craft ──► new recipe ──► new card ◄────────────┘
```

## Sizes

Sizes are measured against the stage with container query units, as today's
card already is, never against the window.

| Size | Width on a wide stage | Height | For |
| --- | --- | --- | --- |
| `glance` | `min(380px, 100cqw - 48px)` | content, at most 240 px | one number, the temperature now, a countdown, an exchange rate |
| `standard` | `min(700px, 100cqw - 160px)`, today's card | up to `100cqh` | a person, a place, an answer, steps |
| `wide` | `min(1040px, 100cqw - 64px)` | up to `100cqh` | a comparison, a trend, a ranking, a route, a video |
| `feature` | `100cqw - 32px` | `100cqh` | a front page, a feature, nearby places, the weather spread |

- **Largest that fits.** A recipe names a preferred size and the sizes it may
  shrink to, and the stage uses the largest that fits. On a 1440 × 900 window
  the open stage is about 913 × 782 px, so `wide` renders near 850 px. On a phone
  every card is `standard` width and its blocks rearrange: a table stacks into
  records, the week scrolls sideways inside its own well, a map takes 16:10.
- **The peek gives way.** A card wider than `standard` leaves no room for the one
  before it to peek, so that card shows a 14 px sliver with its "+n" count, as it
  already does on a phone.
- **Only the front card refracts**, unchanged. Blocks inside a card never refract.
- **No scrolling inside a card on a wide screen.** Each recipe has a fold budget
  checked in the lab at 1280 × 720, the smallest wide stage (about 811 × 602 px).
  A recipe that overflows it is a bug in the recipe. On a phone the stage
  scrolls, as it does now.

## Blocks

Twenty blocks. Every block has an `id` stable within its card, a `slot` its
recipe places it in, and `cite`, the indexes of the sources it came from.

| Block | Shows | Contract and limits | Lights up when said |
| --- | --- | --- | --- |
| `headline` | kicker, title, deck, dateline | title at most 64 characters; deck at most 30 words | no |
| `stat` | one value, its label, its change, a sparkline | value copied from a material; change computed in code; sparkline at most 60 points | the value |
| `facts` | 2 to 8 label and value pairs | today's facts, now with citations | the value, as today |
| `prose` | 1 to 3 short paragraphs | at most 120 words at `feature` size; every sentence passes the number check | no |
| `quote` | a pull quote and who said it | must appear word for word in a page the desk read or a passage it saw, or the block is dropped | no |
| `media` | the lead picture | today's portrait and wide handling | no |
| `gallery` | pictures | today's grid and lightbox | no |
| `table` | rows and columns | columns typed (text, number, date, currency, percent) with units; 8 columns by 12 rows shown, up to 50 rows sent; numeric columns sortable | the row whose label is said |
| `chart` | line, area, column, ranked bar, low-to-high range, sparkline | one y-axis, always; at most 5 series; a line needs 4 points; bars start at zero; a computed text summary | the point whose value or date is said |
| `timeline` | 3 to 12 dated events | year, month or day precision; vertical, or horizontal when wide | the event whose year is said |
| `map` | a pin, pins, a route or an area | a live Mapbox map in front, a still image elsewhere | the pin whose name is said |
| `list` | ordered items with a meta line | optional thumbnail and pin number, paired with a map | the item whose name is said |
| `steps` | 3 to 8 numbered steps | at most 20 words each | the step being described |
| `video` | a YouTube video behind its poster | chapters when the description has them | the chapter being described |
| `forecast` | the hours and the days of the weather | an hour strip and the week's low-to-high bars | the hour or day said |
| `meter` | a value on a fixed scale with named bands | bands come from the skill (the WHO UV scale, for one), never from a model | the value |
| `note` | a caveat | stale data, sources that disagree, delayed prices | no |
| `chips` | follow-up questions | tapping one sends it as if typed | no |
| `countdown` | a live timer or days until a dated event | from `set_timer`, or a date in a material | no |
| `memory` | what GIDEON remembers | each item with a control to forget it | no |

Sources stay a footer on the card, as today, with small numbered markers on the
blocks that cite them.

## Recipes

| Recipe | Size (shrinks to) | Blocks | Needs, or else |
| --- | --- | --- | --- |
| `answer` | standard | headline, prose, facts | a title and a summary or two facts, or no card |
| `profile` | standard, wide with a map | media, headline, facts, timeline, map, chips | as `answer`; a portrait only when the article is surely the right one |
| `figure` | glance (standard) | stat, facts, note | one number with a label, or `answer` |
| `gallery` | standard | gallery | 3 pictures, or no card |
| `compare` | wide (standard, table stacks) | headline, subjects, table, chart, note | 2 to 4 subjects, at least 3 shared attributes, 60% of cells filled, one unit per numeric row; or `profile` |
| `trend` | wide (standard) | headline, stat, chart, facts, note | a series of at least 4 points in one unit, or `figure` |
| `ranking` | wide (standard) | headline, ranked bars, table | at least 3 items in one unit, at most 15 bars; or `answer` |
| `timeline` | wide (standard, vertical) | headline, timeline, media | at least 3 dated events, or `answer` |
| `steps` | standard | headline, steps, facts, media | at least 3 steps, or `answer` |
| `front-page` | feature (wide: lead and two) | masthead, lead story, 2 to 4 stories | at least 3 dated stories inside the recency window, or `profile` of one story |
| `feature` | feature (wide) | media, headline, prose, quote, facts, timeline | a deep brief of 150 words or more from 2 or more sources, or `profile` |
| `recipe` | wide (standard) | media, headline, facts, ingredients table, steps | a page publishing schema.org `Recipe` data, or `steps` |
| `place` | wide (standard) | map pin, headline, facts, the weather now | a confident geocode, or GIDEON asks which one |
| `route` | wide (standard) | route map, duration, facts, first steps | a route from the Directions API, or `answer` |
| `nearby` | feature (wide: list under map) | pins map, list | at least 3 places, or `place` |
| `weather` | feature (wide: now and hours; standard: now and days) | stat, forecast, meter, note | a forecast for a resolved place, or the voice answers alone |
| `market` | wide (standard) | stat, chart with range tabs, facts, note | a price from the provider, or `figure` |
| `video` | wide (standard) | video, headline, chapters, more videos | one embeddable video, or no card |
| `memory` | standard | headline, memory | at least one memory |
| `spread` | feature | tiles on a 12-column grid | each tile's own needs |

Three of them sketched on a wide stage:

```text
compare                                    trend
+------------------------------------+     +------------------------------------+
| COMPARE                        (x) |     | POPULATION                     (x) |
| Lisbon            Porto            |     | Japan, 1960 to the latest year     |
| [photo]           [photo]          |     | latest value · change since peak   |
| ---------------------------------- |     |  ___________________________      |
| City population   545 k    232 k   |     | |        ______------‾‾‾‾‾\__ |    |
| River             Tagus    Douro   |     | |  ____/                      |    |
| July high         28 °C    25 °C   |     | |_/____________________________|   |
| Airport           LIS      OPO     |     | 1960     1980     2000     latest  |
| [sources: 1 2 3]                   |     | peak (year) · source · as of       |
+------------------------------------+     +------------------------------------+

weather spread (feature)
+--------------------------------------------------------------------------+
| LISBON · SATURDAY 13 SEPTEMBER                                       (x) |
| +-------------+ +--------------------------------------------------------+ |
| | 24°  Sunny  | | temperature, next 24 h   ______                      | |
| | feels 25°   | |                   ______/      \______                | |
| | H 27  L 18  | | rain chance       ▁ ▁ ▁ ▂ ▅ ▆ ▃ ▁ ▁                  | |
| +-------------+ +--------------------------------------------------------+ |
| Sat ▬▬▬▬▬▬ 18–27   Sun ▬▬▬▬ 17–25   Mon ▬▬▬▬▬ 16–24   ...  UV 7 High      |
+--------------------------------------------------------------------------+
```

The numbers in these sketches are placeholders for layout, not claims.

## Skills

The speaking model's front door stays small. Each tool is a decision it has to
get right with someone waiting, and every description is prompt it reads before
its first word.

### Tools the speaking model sees

| Tool | Its one job | Recipes | Sources | Needs | Phase |
| --- | --- | --- | --- | --- | --- |
| `research` (exists) | find out anything about the world and brief it | answer, profile, figure, compare, trend, ranking, timeline, steps, front-page, feature, recipe | Exa, and the desk tools below | `EXA_API_KEY` | 1 |
| `show_images` (exists) | pictures of a thing | gallery | Exa, Openverse | none | done |
| `weather` | the forecast or conditions now for one place, up to the provider's horizon | weather, figure | MET Norway or Open-Meteo; Mapbox geocoding | a provider decision | 2 |
| `markets` | the price and recent history of a stock, index, currency or cryptocurrency | market | a provider still to choose; Frankfurter for currencies | a provider key | 2b |
| `show_map` | where a place is, how to get between two, what is near one | place, route, nearby | Mapbox Geocoding v6, Directions v5, Search Box | Mapbox tokens | 3 |
| `show_video` | a video the user asked to watch | video | YouTube Data API v3; Exa and oEmbed as a fallback | `YOUTUBE_API_KEY`, optional | 4 |
| `craft` | combine cards already on screen into one | compare, trend, pins map | the cards' own materials | none | 5 |
| `show_memories` | show what GIDEON remembers, with a way to remove each item | memory | the memory store | none | 5 |

All of them are read-only, with one exception inside one of them. `show_map` in
`nearby` mode may need the browser's position, which the skill asks for through
the browser bridge as a new `get_location` client tool. The model never calls it.
Asking shows a permission prompt, which is not unobservable, so in a speculative
turn the skill stops before asking and the guess is abandoned, exactly as a
guess that reaches for `set_timer` is today. The real turn then asks.

### Tools only the research desk sees

| Desk tool | Captures | Source | For |
| --- | --- | --- | --- |
| `search`, `read` (exist) | dated stories, page text | Exa | every recipe; quotes are checked against page text |
| `entity_facts` | a record: dates, places, coordinates, population, founding, official site, portrait | Wikidata, Wikipedia | profile, place facts, compare |
| `country_data` | indicator series by country and year | World Bank API | trend, compare, ranking |
| `chart_data` | the series behind a published chart | Our World in Data (`.csv` and `.metadata.json` beside any grapher chart) | trend, ranking |
| `page_data` | schema.org records a page publishes: `Recipe`, `Event`, `Product`, `NewsArticle` | a page already in the results | recipe, compare, timeline |
| `geocode` | coordinates for a place in the brief | Mapbox Geocoding v6 | a map on a profile or feature |

For the front page, `search` gains Exa's `category: "news"` with a start date,
which Exa supports for that category.

### Not built, and why

- **Sports.** No free source with dependable coverage. Later, once a provider is
  chosen.
- **Flights.** Licensing.
- **Calculators and conversions.** The voice answers them; a card adds nothing.

## Keeping the wrong skill from firing

Five layers, cheapest first.

### 1. Narrow jobs, generated descriptions

Every skill has a manifest ([Appendix A](#appendix-a-a-skill-manifest)): its one
job, when to use it, what it is never for *and which tool is*, three examples and
two counter-examples. The description the model reads is generated from the
manifest, so every description has the same shape and none can be left vague.
Examples used in descriptions never appear in the test corpus, so a pass is not
the model recognising its own prompt.

### 2. The boundary table

Written before a skill is built, for every pair of tools that could be
confused, and turned straight into corpus cases.

| The user says | Right | Tempting | Why |
| --- | --- | --- | --- |
| what's the weather in Lisbon | `weather` | `research` | a forecast is data with a source; the desk costs seconds |
| what's Lisbon like in spring | `research` | `weather` | climate and character, not a forecast |
| what was the weather on the day of the moon landing | `research` | `weather` | history, not a forecast |
| show me Lisbon | `show_images` | `show_map` | "show me" a place means pictures unless the words are map, where, directions or near |
| where is Lisbon; show me Lisbon on a map | `show_map` place | `show_images` | asked for the map |
| tell me about Lisbon | `research` (profile with a map block) | `show_map` | knowledge; the map comes with the card |
| how far is Porto from Lisbon | `show_map` route | `research` | a distance by road |
| how long is the flight to Porto | `research` | `show_map` | flights are not in the Directions API |
| coffee near me | `show_map` nearby | `research` | places by category around a point |
| best coffee in Lisbon | `research` | `show_map` | "best" is reviews and opinion |
| show me a video on tying a bowline | `show_video` | `research` | a video was asked for |
| how do I tie a bowline | `research` (steps) | `show_video` | words were asked for; the card may offer a video chip |
| how's Apple doing | `markets` | `research` | "doing", "stock", "shares" of a listed company |
| what does Apple make | `research` | `markets` | about the company, not its price |
| price of apples | `research` | `markets` | groceries |
| compare Python and Rust | `research` (compare) | `research` (profile) | compare, versus, difference between, which is better |
| compare them, with two cards on screen | `craft` | `research` | the subjects are already on screen |
| population of Japan | `research` (figure) | `research` (trend) | one value |
| population of Japan since 1960 | `research` (trend) | `research` (figure) | since, over time, history of |
| picture this | no tool | `show_images` | a figure of speech |
| I'm under the weather | no tool | `weather` | a figure of speech |
| map out my week | no tool | `show_map` | a figure of speech |
| sort it by price | no tool (a stage control) | `research` | about the open card |
| what do you remember about me | `show_memories` | `recall` | asked to see |
| do you remember my sister's name | `recall` | `show_memories` | asked a question |

### 3. Guards inside each skill

Arguments are checked before any request leaves, and a call that does not fit is
refused with one sentence the model can act on, never executed wrongly. `weather`
refuses a date past its horizon ("That is beyond the forecast; use research").
`show_map` refuses a destination that geocodes to nothing. A refusal costs a
round of silence, which is why this is the third layer and not the first.

### 4. Recipes gated on materials, in code

The composer is offered only the recipes whose needs the materials already meet.
It cannot choose `trend` when no series has four points, because `trend` is not
on its list. After it chooses, the resolved card is checked again, and one that
fails steps down its recipe's fallback chain.

### 5. A corpus that gates every change

`npm run benchmark:routing` sends about 240 utterances
([Appendix B](#appendix-b-the-routing-corpus)) through `streamTurn` with the
speaking model real and every tool stubbed, the same way `benchmark:research`
measures routing today, and prints a confusion matrix. A change to the prompt, a
description or the tool list ships only when:

- overall accuracy is at least 95%;
- every tool's precision is at least 92% and its recall at least 90%;
- no side-effecting tool (`set_timer`, `remember`, `forget`, `offer_link`) fires
  when it was not asked for;
- today's eight routing cases still pass.

The same corpus runs against the fallback chat model, reported and not gated.

**As built (14 September 2026), for the eight tools there are today.** The
corpus has 127 cases rather than 240, since the new skills are not built, and
each new skill adds its own. The gates held on two runs in a row at
98.4%, from 90.1% with the hand-written descriptions. The descriptions
were not what moved it. What did:

- A prompt rule that contradicted the card rule was removed.
- A rule now forbids claiming a tool's work without calling it.
- The routing rules come last in the prompt.
- `remember` gained `replaces`, for a fact that has changed.

The figures are in RESEARCH_STAGE.md. Screen commands need no tool, and the
prompt now says so: "bring the first one back" had reached for `offer_link`.

Tools also cost time. The list grows from 8 to at most 14, and every description
is read before the first token, so `npm run benchmark:models` measures time to
first token before and after each addition. A regression past 60 ms at the
median is paid back, with shorter descriptions, before it ships.

## How a card is made

```text
user asks
  │
  ▼
speaking model picks one tool
  │
  ├─► action (pending) ──► a searching pane shaped like the skill
  │
  ├─ direct skills: weather · show_map · show_video · markets
  │     API calls ──► materials ──► recipe template, in code ──► card
  │
  └─ research
        desk: search · read · entity_facts · country_data · chart_data · page_data · geocode
          │                                  │
          ▼                                  ▼
        brief ──► speaking model ──► voice   materials, captured from responses
                                             │
                                             ▼
                       composer, one model call: a recipe and blocks of pointers
                                             │
                                             ▼
                       resolver: pointers become values; derived values computed
                       validator: numbers, quotes, dates, minimums, fold budget
                         └─ fails ──► fallback recipe ──► … ──► no card
                                             │
                                             ▼
                       card (partial) ──► card_patch ──► card_patch (final)
                                             │
                                             ▼
                       browser: held while the turn is a guess; placed once kept
```

### Materials are captured, not written

The desk's executor (`runAgent` in `src/lib/tools/research.ts`) already sees every
result and page. It now keeps them: search results become a `stories` material,
each page read a `text` material, each data tool a `record`, `table`, `series`
or `geo` material, each stamped with its URL and when it was fetched. The desk's
prompt gains the new tools and nothing else.

### Only what the brief relied on

Search results the brief did not cite are not handed to the composer.
`citedSources()` already knows which those are, and leaving them out means a card
cannot bring back a stale page the desk decided against. Materials from data
tools are always kept, because the desk called those on purpose.

This is also how a card gets richer than the brief: it draws on the passages and
pages behind the brief (eight results of 900 characters per search, pages of up
to 10,000), not only on the 180 words that were spoken.

### The composer writes pointers

One call to `openai/gpt-5.6-luna` with reasoning off and a JSON schema, given the
question, the brief, a digest of the materials (id, kind, fields or columns, row
count, first and last values, units, date range) and the recipes those materials
qualify for. It answers with a recipe and blocks whose values are pointers:

```jsonc
{
  "recipe": "trend",
  "title": "Population of Japan",
  "blocks": [
    { "slot": "lead", "type": "stat",
      "value": { "from": "m2", "pick": "last" },
      "change": { "derive": "percent-change", "of": { "from": "m2", "pick": "max" }, "to": { "from": "m2", "pick": "last" } },
      "label": "Latest" },
    { "slot": "chart", "type": "chart", "form": "line",
      "series": [{ "from": "m2", "label": "Japan" }],
      "annotate": [{ "at": { "from": "m2", "pick": "max" }, "label": "Peak" }] },
    { "slot": "facts", "type": "facts",
      "items": [{ "label": "Source", "value": { "from": "m2", "field": "source" } }] }
  ]
}
```

The whole pointer grammar is small enough to test exhaustively:

| Pointer | Means |
| --- | --- |
| `{ from }` | a whole material |
| `{ from, field }` | one field of a record |
| `{ from, row, column }` | one table cell, **by label**, never by index, so a model's miscount cannot pick the wrong row |
| `{ from, pick: first \| last \| max \| min \| "at:2008" }` | one point of a series |
| `{ derive: change \| percent-change \| cagr \| rank \| distance, … }` | computed in code; the card shows the formula on hover |

Titles, labels, decks and headlines are the model's own words, and they still
pass today's number check against the brief and materials.

### The validator

It keeps today's checks and adds five:

1. a quote must appear word for word (after normalising spaces and quotation
   marks) in a captured page or passage;
2. a date must appear in a material;
3. every numeric table row and chart axis has one unit;
4. the recipe's minimums hold after resolution;
5. the card fits its fold budget.

A card that fails steps down its fallback chain: `trend` to `figure` to `answer`
to no card. A block that fails alone is dropped and the recipe lays out again
without it, the way a gallery closes over a picture that will not load.

### Progressive assembly

A card is sent as soon as it has something certain to show, then patched.

```text
0 s       tool call ──► searching pane
0.3 s     holding line is heard ("Let me look that up.")
~1 s      entity_facts returns ──► card (partial): portrait, name, dates
4 to 6 s  brief returns ──► the voice starts answering
6 to 8 s  composer and resolver ──► card_patch (final): summary, timeline, facts
```

These are targets built from today's measurements (a brief in 3.5 to 6.4 s, a
card 2.7 s after it at the median) plus one composer call, and Phase 1 measures
them. An early partial card is sent only when identity is certain: an exact
Wikidata label match for the subject the question named.

Direct skills need no composer. Weather targets a card within 1.2 s of the call
at the median.

### Speculative turns

Unchanged. A guess's `card` and `card_patch` frames wait in `heldRef` and are
delivered only if the guess is kept. Because data skills are read-only, a guess
may start the forecast lookup before "what's the weather in Lisbon" is finished.

## The schema and the wire

### The card

```ts
export type CardSize = 'glance' | 'standard' | 'wide' | 'feature'

export interface CardV2 {
  schema: 2
  recipe: RecipeId
  size: CardSize
  /** The question it answers, carried over from the searching pane. */
  query: string
  /** For the shelf, the stage judge and the speaking model. */
  title: string
  blocks: Block[]
  sources: CardSource[]
  /** When the newest thing on the card was true. */
  asOf: string | null
  /** How long it stays current: weather 30 minutes, a price 1, a person years. */
  freshForMs: number | null
  /** The tool and arguments that made it, so "refresh it" can run them again. */
  origin: { tool: string; args: Record<string, unknown> }
  /** What voice or touch may change; the stage director chooses only from these. */
  controls: CardControl[]
  /** Words and numbers that light an element when they are spoken. */
  mentions: Mention[]
  /** More blocks are on their way in card_patch frames. */
  partial: boolean
}

interface BlockBase {
  id: string
  slot: string
  /** Indexes into `sources`. */
  cite: number[]
}

export type Block =
  | (BlockBase & { type: 'headline'; kicker?: string; title: string; deck?: string; dateline?: string })
  | (BlockBase & { type: 'stat'; value: string; label: string; change?: Change; spark?: Point[] })
  | (BlockBase & { type: 'facts'; items: Fact[] })
  | (BlockBase & { type: 'table'; columns: Column[]; rows: Cell[][]; sortable: string[]; caption?: string })
  | (BlockBase & { type: 'chart'; form: ChartForm; x: Axis; y: Axis; series: Series[]; annotations: Annotation[]; summary: string })
  | (BlockBase & { type: 'timeline'; events: TimelineEvent[] })
  | (BlockBase & { type: 'map'; view: 'pin' | 'pins' | 'route' | 'area'; features: GeoFeature[]; camera: Camera; still: string })
  | (BlockBase & { type: 'video'; provider: 'youtube'; videoId: string; title: string; channel: string; seconds?: number; chapters: Chapter[]; poster: string })
  | (BlockBase & { type: 'forecast'; hours: HourForecast[]; days: DayForecast[] })
  // …prose, quote, media, gallery, list, steps, meter, note, chips, countdown, memory

/** A value the resolver computed rather than copied. */
interface Derived {
  formula: string
  inputs: string[]
}
```

A block on the wire holds resolved values. Pointers exist only between the
composer and the resolver on the server; the browser never resolves anything.

### The materials

```ts
export type Material =
  | { id: string; kind: 'record'; subject: string; fields: Record<string, Value>; source: SourceRef }
  | { id: string; kind: 'table'; columns: ColumnMeta[]; rows: Value[][]; source: SourceRef }
  | { id: string; kind: 'series'; name: string; unit: string; x: 'time' | 'category'; points: Array<[string, number]>; source: SourceRef }
  | { id: string; kind: 'geo'; features: GeoFeature[]; source: SourceRef }
  | { id: string; kind: 'events'; items: Array<{ date: string; precision: 'year' | 'month' | 'day'; label: string }>; source: SourceRef }
  | { id: string; kind: 'stories'; items: Story[]; source: SourceRef }
  | { id: string; kind: 'text'; text: string; source: SourceRef }

interface Value { raw: string; number?: number; unit?: string; date?: string }
interface SourceRef { url: string; title: string; fetchedAt: string; endpoint?: string }
```

### Protocol version 3

- **`ready`** gains `features` (which skills this server can run) and
  `mapboxToken` (the public token). `/api/config` carries the same for the HTTP
  fallback.
- **`card`** carries a `CardV2`, or today's card. The browser draws today's
  through an adapter, so a tab left open on an older build keeps working.
- **`card_patch`** is new: `{ t: 'card_patch', id, call, blocks, drop?, partial }`.
  Blocks are upserted by id. A patch for a card no longer on screen is ignored.
- **`stage`** gains `{ op: 'control', card, control, value }`.
- **`turn.screen`** gains a digest of the open card, at most 400 characters.
- **`get_location`** is a new client tool, socket only, returning a rounded
  position or a refusal.

Bounds are enforced in code before a frame is sent: a card frame at most 64 KB, a
patch at most 32 KB, 50 table rows, 400 points per series (downsampled with
Largest-Triangle-Three-Buckets), 50 map features, and route geometry simplified
to 500 coordinates. Cloudflare raised the WebSocket message limit to 32 MiB in
October 2025, so these bounds exist for the phone's radio and the renderer, not
for the platform.

## Liquid glass for dense content

### Four surfaces, one material

| Surface | What it is | Refracts |
| --- | --- | --- |
| **Pane** | today's `.glass-pane`: the card itself | yes, when in front |
| **Well** | a calm, darker reading surface inside a pane, for tables, charts, maps and video | no |
| **Chip** | today's small capsules: sources, controls, follow-ups | small buttons already share one map |
| **Lens** | a small glass tooltip over a chart point or a map pin, in three fixed sizes so their displacement maps are built once | yes |

A well has no `backdrop-filter` of its own, since the pane has already blurred
the room, and its corner radius is the pane's minus its inset (30 − 14 = 16 px),
so the curves stay concentric.

### How dark a well has to be, measured

A chart's colours have to read over every mood the room can be in, and the room
is a moving shader. On 13 September 2026 the well was composited over each mood
palette in `src/lib/mood.ts`: the blurred backdrop taken as the palette's body
with 35% of its crest (a deliberately bright case), the pane's 5% of white on
top, then the well's own tint of `rgb(5, 7, 11)`.

| Mood | Backdrop | Well at 60% | Well at 72% |
| --- | --- | --- | --- |
| neutral | `#364a76` | `#1d2538` | `#161c2b` |
| curious | `#256d71` | `#163336` | `#112629` |
| focused | `#273f93` | `#172144` | `#111933` |
| happy | `#8e5431` | `#3e291e` | `#2d1f18` |
| concerned | `#5c3258` | `#2b1c2d` | `#201623` |
| surprised | `#6b399c` | `#311f47` | `#241835` |

The eight-colour dark categorical palette below then passed every check (lightness
band, chroma floor, colour-blind separation, normal-vision separation, 3:1
contrast) on **all six wells at 72%**. At 60%, green fell to 2.76:1 on the happy
well. **Wells are tinted at 74%**, a little past the measured line.

Text inks on the same wells, by WCAG contrast (4.5:1 needed for small text):

| Ink | Worst well | Verdict |
| --- | --- | --- |
| primary `#f6f8ff` | 14.84:1 | pass |
| today's summary, `#e2e8f1` at 80% | 8.63:1 | pass |
| today's fact labels, `#bfe9ff` at 55% | 4.69:1 | passes narrowly; labels in wells move to 70% (6.70:1) |
| a common muted grey, `#898781` | 4.39:1 | fails on curious and happy |
| proposed muted and axis ink, `#a9b1bd` | 7.28:1 | pass |

A unit test recomputes both tables from `PALETTES`, so a change to the room that
makes a well unreadable fails the build instead of a card.

### Colour for data

- **Categorical, fixed order:** `#3987e5` blue, `#d95926` orange, `#199e70`
  aqua, `#c98500` yellow, `#d55181` magenta, `#008300` green, `#9085e9` violet,
  `#e66767` red. Assigned in order and never cycled; a ninth series folds into
  "Other".
- **Charts where any two marks can touch** (maps with categories, scatter) use
  only the first three, which pass all pairs on the worst well.
- **Status is its own palette** and is only used when a colour *means* good or
  bad, always with an icon and a word.
- **Text never wears a series colour.** The line is blue; its label is ink.
- **The room may change colour; the data may not.** Only chrome (the rim, the
  glow) answers the mood.

### Type

- **GT Alpina** (display): headlines, mastheads, decks in its light italic, and
  the number on a `figure` card, which is GIDEON's voice.
- **Frances** (text): body, and every number inside a data block, where a
  display face would slow reading.
- **IBM Plex Mono** (utility): kickers, datelines, units, axis labels.
- **Figures.** Numbers that line up in columns (tables, axes) use tabular
  figures. A number standing alone uses proportional figures, which also means
  dropping `tabular-nums` from today's `.card-figure strong`, where equal-width
  digits make a large number look loose.

### Motion

| Moment | Movement | Timing |
| --- | --- | --- |
| Table arrives | rows rise in turn | 30 ms apart, 400 ms at most |
| Line chart arrives | each line draws left to right | 700 ms |
| Bars arrive | grow from the baseline in turn | 500 ms, 40 ms apart |
| Map arrives | flies from a wide view to the place while the holding line is spoken | about 1.6 s |
| Timeline arrives | events light along the line | 60 ms apart |
| Something is said | its element brightens; a chart point pulses once | 400 ms |
| Numbers | never count up | — |

Numbers never count up, because a counter passes through values that are not
true, and this is the one place in the interface where everything shown has to
be. Reduced motion turns every travel into a cross-fade, as it does today.

### Searching panes

The pane shown while a skill works takes that skill's shape, so the card grows
out of it rather than replacing it: a map skill shows a dim world with a slow
pulse, weather a tile and a faint curve, video a 16:9 shimmer with three chapter
lines. Research gains the progress line [RESEARCH_STAGE.md](RESEARCH_STAGE.md)
already asks for ("Searching: Einstein biography", "Reading britannica.com").

## Charts and tables

### Why its own chart kit

SVG components over `d3-scale`, `d3-shape`, `d3-array` and `d3-time-format`,
rather than a charting library:

- glass needs its own chrome, and spoken highlighting needs a hook on every point;
- motion has to follow the rules above, including "never count up";
- it renders on the server pass, where there is no canvas;
- it stays small. Recharts is 7.4 MB unpacked on npm and renders through React
  per point; the four d3 modules are tree-shakable functions.

### Rules for charts

| Rule | Enforced by |
| --- | --- |
| One y-axis. Two measures in different units become two charts sharing the x-axis, never a dual axis | validator |
| A line needs at least 4 points; a bar chart at least 3 bars and at most 15 | validator |
| Bars start at zero | renderer |
| At most 5 series; past 4, every series is labelled at its end | validator, renderer |
| Time is sorted and deduplicated; a missing value is a gap, never a zero | resolver |
| Over 400 points is downsampled, keeping its shape | resolver |
| At most 5 y-axis ticks, on round numbers | renderer |
| Lines are 2 px, bars at most 24 px thick with 4 px rounded ends, gridlines solid hairlines | renderer |
| Label the end, the peak and the one series the story is about, never every point | recipe |
| Every chart has a computed summary, such as "Rose from 1.2 in 2000 to a peak of 3.9 in 2021, then fell to 3.4", and a table view | block |
| Hover and keyboard both show the same readout; a readout never holds a value found nowhere else | block |
| An "as of" date and the source sit under every chart | recipe |

### Rules for tables

- Numbers right-aligned, in tabular figures, with one number of decimals per
  column and the unit in the header, not in every cell.
- The first column stays put when the table scrolls sideways inside its well.
- At most 12 rows shown. "Show all 34" grows the card to `feature` rather than
  scrolling it.
- A numeric column sorts by tap or by voice ("sort it by price").
- A "best" marker appears only when the skill declares which direction is better
  for that row. The model never decides a winner.
- Missing values show as a dash with a note, never as zero.
- Each cell's source appears on hover, through the lens.

## Maps

### Library

`mapbox-gl` 3.30.0, released on 3 September 2026, loaded with `import()` only
when a map block appears, and fetched early the moment a `show_map` call is
pending, so the download runs during the holding line.

### One map for the whole page

`map-pool.ts` creates a single `mapboxgl.Map` into a detached element and moves
that element into whichever map block is in front. The room's shader and this map
are the only two WebGL contexts ever alive, and a conversation costs one map load
however many place cards it shows. The card that steps back shows a still.

### Style

Mapbox Standard, configured rather than restyled: `lightPreset: 'night'`,
`theme: 'monochrome'` (or `faded`), point-of-interest labels off, and
`colorWater` and `colorLand` tuned toward the room's blues in the lab, against
the glass. Satellite on request. The Mapbox logo and attribution stay visible, as
the terms require, and change only colour.

### Stills

A Static Images API URL, built on the server, is used for the peek, the shelf
tab, a browser without WebGL, and data-saver mode. The browser loads that image,
so its URL carries the public token.

### Tokens

- `MAPBOX_PUBLIC_TOKEN`: restricted by URL to chatgideon.com and localhost, sent
  to the browser in `ready`.
- `MAPBOX_SERVER_TOKEN`: a secret, for geocoding, directions and search.

### The three modes

| Mode | Calls | Card | Voice |
| --- | --- | --- | --- |
| `place` | Geocoding v6 forward, proximity-biased to the user's city | pin, name, type, local time, the weather now | "It's on the Tagus, in the west of Portugal." |
| `route` | Geocoding for both ends, then Directions v5 (`driving-traffic`, `walking`, `cycling`; GeoJSON geometry, simplified overview) | the line, duration, distance, the first few turns | "About three hours by car." |
| `nearby` | Search Box `/category` around a point | numbered pins and the same numbers in a list | names the first two or three |

"As the crow flies" is computed from two geocodes in code and labelled as
computed.

### When a name is ambiguous

If the results for a name span different countries and nothing in the
conversation or the user's city decides between them, GIDEON asks ("Springfield,
Illinois or Massachusetts?") and the card waits. A wrong pin is worse than no
pin, for the same reason a wrong face is worse than no face.

### Camera and voice

A place flies in from a wide view while the holding line is spoken. A route fits
both ends with room for its panel. Nearby pins appear in the order GIDEON names
them, and a pin brightens as its name is said. Scroll-zoom needs a modifier key,
so a page scroll is never captured by the map, and zoom, fit, satellite and 3D
are glass chips as well as voice controls.

### Location

Coarse by default: the Worker reads city, coordinates and timezone from
`request.cf` in `server.ts` when the socket opens and hands them to the session,
so "the weather here" needs no permission prompt. A precise position is used
only for "near me", only through `get_location` with the browser's permission,
rounded to three decimal places (about 110 m), and never stored unless the user
asks GIDEON to remember a place.

### Cost

Mapbox's free monthly allowances are 50,000 web map loads, 100,000 temporary
geocoding requests, 100,000 directions requests and 50,000 static images. The
one-map pool keeps a session to one load.

## Video

### Finding a video

- **YouTube Data API v3**, `search.list` with `videoEmbeddable`, `safeSearch`
  moderate and `videoSyndicated`, then `videos.list` for duration, description
  and region restrictions.
- **Quota.** The default is 10,000 units a day. A search costs 100, which is 100
  searches a day; a `videos.list` call costs 1. Results are cached by query for
  24 hours, and the region check uses the Worker's country.
- **Fallback.** When the key is missing or the quota spent, Exa restricted to
  youtube.com finds the video, and oEmbed (no key) gives its title, channel and
  poster. The card loses duration and chapters, and nothing else.

### Chapters

Lines in the description that start with a timestamp, at least three of them and
the first at 0:00, become chapters. "Skip to the part about the rabbit" is a
stage control that seeks to the chapter whose title matches.

### Playing it

- The card shows a poster from `i.ytimg.com` and a glass play button. The player
  (`youtube-nocookie.com/embed`, with the IFrame Player API for play, pause, seek
  and volume) loads only on play, which keeps a heavy iframe and its cookies off
  every page that merely shows a video.
- GIDEON never starts a video by itself. It shows the card and says one line;
  "play it" or a tap starts it.
- Embed only, through the official player. Nothing is downloaded or re-hosted.

### The open microphone

GIDEON listens while it speaks, and a video is someone else speaking in the same
room. Silero rates a video's dialogue as speech because it is speech, so this
needs a measurement before a design:

1. **Spike.** Play a dialogue-heavy video at normal volume for three minutes with
   echo cancellation on, and count the turns that start. Whether the browser's
   echo canceller treats the page's own video audio as its reference decides
   everything after this step.
2. **If it does not:** while a video plays, a turn needs GIDEON's name or a tap to
   start, and speech that is not addressed to GIDEON is ignored.
3. **Either way:** when the user does address GIDEON, the video pauses (not
   ducks), and "carry on" resumes it.

Phase 4 does not ship until the spike's count is zero false turns over those
three minutes.

## The front page and the feature

GIDEON's register is a very formal 1955 letter about a small matter, and the
newspaper cards borrow the same decade: a broadsheet set in glass.

### Front page

```text
+------------------------------------------------------------------------------+
| GIDEON · SATURDAY 13 SEPTEMBER 2026 · EVENING EDITION                    (x) |
|==============================================================================|
| +--------------------------------------+ | 3 HOURS AGO · REUTERS             |
| |                                      | | Headline of the second story      |
| |           lead photograph            | | One line on what happened.        |
| |                                      | |-----------------------------------|
| +--------------------------------------+ | 5 HOURS AGO · BBC                 |
| LEAD STORY · 1 HOUR AGO                  | Headline of the third story       |
| Headline of the lead story, set large    | One line on what happened.        |
| A deck of up to thirty words, set in the |-----------------------------------|
| light italic, saying why it matters.     | YESTERDAY · AP                    |
| [1] [2]                                  | Headline of the fourth story      |
+------------------------------------------------------------------------------+
```

- The edition follows the user's local time: morning before noon, afternoon
  before five, evening after.
- Stories come from `search` with `category: "news"` and a start date, and each
  is dated. A story older than 48 hours says its date in full rather than "hours
  ago".
- Headlines are at most 10 words and decks at most 30, written by the composer
  from each story's own passages, and they pass the number check against those
  passages.
- The lead is chosen by recency and by how many sources carry the story, and
  every story carries its own source markers.
- Hairline column rules, headlines in GT Alpina, datelines in Plex Mono, decks
  in GT Alpina Light Italic.

**As built (14 September 2026).** Four things changed on the way, each to keep
the page honest or full:

- No model writes a headline or a deck. A headline is the publisher's own
  title, with the publisher's name or a section's taken off its end, and a deck
  is the story's own passage saying what happened, at most thirty words. A
  model's ten-word headline is a rewrite no source said.
- Stories come from a desk tool of their own, `top_stories` (Exa's news
  category, the last 36 hours or 7 days), rather than from `search`, so the desk
  can ask for the news in one call and the card is drawn from what it returns.
- The lead is the story the most outlets are carrying; tellings of the same
  event are grouped by the words their headlines share. Every story's dateline
  names its outlet and links to it, so there is no row of source markers.
- A front page is the height of the stage at any size. The lead's picture takes
  the height its words leave, and the column holds as many whole stories as fit
  (the desk fetches up to six); a story that would be cut off wraps out of sight
  and out of the tab order. Datelines count hours for a day, then say
  "Yesterday", a weekday, or the date; the edition is morning, afternoon,
  evening or late.

### Feature

For "tell me everything about", "explain", "the full story". `research` gains a
`depth` argument, `quick` or `deep`; a deep run may read pages and take a second
round, and the voice still answers in under sixty words while the card holds the
rest. **The voice stays short; the card goes deep.**

The feature holds a hero picture, a headline and deck, two short paragraphs with
a drop cap, one pull quote that must be verbatim, a facts sidebar, and a timeline
strip along the bottom.

## Weather and markets

### Weather

| | Open-Meteo | MET Norway |
| --- | --- | --- |
| Cost | free for non-commercial use under 10,000 calls a day; a subscription for commercial use | free |
| Licence | CC BY 4.0 | CC BY 4.0 |
| Horizon | 16 days | 9 days |
| Extras | hourly, air quality, its own geocoding | UV; identify with a User-Agent, honour `Expires`, stay under 20 requests a second |

**Recommendation.** If chatgideon.com stays a non-commercial portfolio with no
ads or subscriptions, Open-Meteo fits best. The day it becomes commercial, switch
to MET Norway or pay Open-Meteo. The skill sits behind a provider interface, so
the switch is configuration.

The card is the `weather` spread: the temperature now with its condition, feels
like, high and low; the next 24 hours as a temperature line with the chance of
rain as separate columns underneath, sharing the hours rather than an axis; the
week as low-to-high bars; a UV meter on the WHO bands. Units follow the browser's
locale and a remembered preference ("I prefer Fahrenheit").

**As built (15 September 2026).** Open-Meteo, as recommended, behind a provider
interface. Four things differ from the sketch:

- Coarse location comes from `request.cf` as planned. The Worker hands it to the
  Durable Object in a header only it can set, and GIDEON names the place it
  used, because an address lookup can be wrong. Locally there is no lookup, and
  GIDEON asks which place.
- The week is seven days, not the provider's sixteen, because the card shows
  seven. A day past it is refused with a pointer to research.
- Units follow the user's timezone (Fahrenheit for clocks in the United States)
  or what they asked for, rather than the browser's locale, which the server
  does not see.
- The forecast carries sunrise and sunset, and a day is only called wet at a
  20% chance of rain or more.

The routing corpus holds weather against research at 15 of 15 each way.
Figures are in RESEARCH_STAGE.md.

### Markets

- **Currencies:** Frankfurter, which serves the European Central Bank's reference
  rates with no key.
- **Cryptocurrencies and stocks:** a provider to choose by measuring latency,
  coverage outside the US, and whether its licence allows display.
- **The card:** price and change against the previous close, a chart with 1D, 1M,
  1Y and 5Y tabs, market capitalisation, 52-week range and volume, and a note
  saying how delayed the price is.
- **Never advice.** GIDEON states the price and the history. Asked whether to
  buy, it says that is not something it can advise on, and the card carries no
  recommendation of any kind.

## The screen as a workspace

### Controls

The stage judge becomes a **stage director**. It keeps the design that made the
judge work (it is asked what the message is *about*, and code decides the move)
and adds a second question: does the message ask to change the open card, and
how? Its answer must be one of the controls that card declares.

| Block | Controls |
| --- | --- |
| table | sort by a column, either direction; highlight a row |
| chart | show as a table; highlight a series; change range (market) |
| map | zoom in or out; fit; satellite; 3D; focus pin *n* |
| video | play; pause; seek to a chapter or a time; mute |
| gallery | open picture *n*; next; previous |
| timeline | focus an event |

**A control never fetches.** Anything that needs new data (walking instead of
driving, a different week) is a new tool call by the speaking model. The
speaking model is told that the screen follows along by itself, so it
acknowledges in a few words ("Cheapest first.") rather than claiming it cannot
sort. A control that names a column or a chapter the card does not have is not
applied.

### Crafting

| Materials on screen | Craft | Card |
| --- | --- | --- |
| two or more records of the same kind (people, cities, phones) | compare | `compare`; research fills fields only one has |
| two or more places | map | pins on one map; for two, a route offered as a chip |
| series in one unit | overlay | `trend` with several lines |
| series in different units | stack | small multiples sharing the x-axis, never a dual axis |
| a figure with a history | chart it | `trend`, fetching the history |

- **By voice:** "compare them", "put them on a map", "chart that over time" call
  `craft` with the card ids.
- **By touch:** drag a shelf tab onto the front card. Only the crafts those two
  cards can make light up, and choosing one sends it as a turn, shown in the
  conversation as if typed, so GIDEON answers it aloud.
- **Materials live on the server** for the session, keyed by card id: in the
  Durable Object with a one-hour lifetime, or in the process on the Node host. The
  browser sends ids, never data. After a reload the materials are gone, and
  crafting re-runs each card's `origin` first.

### Spreads

A spread lays several blocks on a 12-column grid inside one feature-size card:
the weather's three parts, or a trip's map, timeline and forecast. The spread's
frame refracts and its tiles are wells, so a board of five tiles costs one
displacement map, not five.

### Persistence

The shelf is saved to IndexedDB per conversation: at most 12 cards, which one was
in front, and whether the stage was open. It is restored on reload with the cards
put away. A restored card past `asOf + freshForMs` carries a note ("From three
hours ago") and a refresh chip, and "refresh it" re-runs its `origin` through the
speaking model, with the arguments validated again on the server. **New**
clears it, as it clears everything today.

### The memory card

"What do you remember about me?" puts every memory on a card, each with a
control to forget it. A tap sends a `memory_forget` frame over the socket, the
server removes it through `store.mutate` and records it in the ledger, and the
card updates. This makes memory auditable in the place the user is already
looking, which is the "answerable and editable" memory that Phase 3 of the
roadmap asked for.

## Speaking in step with the screen

### Mentions

Today a fact brightens when its value is heard. The same idea covers every block:
the server builds a `mentions` index when the card is made (numbers normalised the
way `numbersIn()` does, years, and proper names of four letters or more), each
pointing at the elements it should light. As the caption reveals words on the
audio clock, the browser matches them against the index and sets `data-said` on
those elements: a table row, a chart point, a pin, a timeline event, a chapter.
Only the card in front listens. A token that points at more than three elements
lights none, since "2024" in a table of years means nothing in particular.

### The eyes follow

The docked face already takes a gaze from `--gaze-x` and `--gaze-y`. When an
element lights up, the gaze turns toward its centre for a moment, so GIDEON looks
at the point on the chart it is talking about.

### What the speaking model knows

The open card's digest travels in `turn.screen`, at most 400 characters: a
table's columns and row labels; a chart's series with first, last and peak; a map's
places in order; a video's title and chapter titles. "Which is cheaper?" and "when
was the peak?" are then answered from what the user can see. The existing line
stays: refer to the card, never read it out.

## Security, privacy and licences

### Output

- No block uses `dangerouslySetInnerHTML`. Charts are React elements built from
  numbers, never SVG strings.
- Links are `http` or `https` only, as today. Pictures are `https` only. A video
  id must match `^[A-Za-z0-9_-]{11}$`. Coordinates must be finite and in range.
- Colours come from tokens. No model output reaches a style attribute.

### Fetching pages

`page_data` reads pages through Exa's contents endpoint, which already fetched
them. Where a page has to be fetched directly, it must be `https`, a public
hostname and not an IP literal, under 2 MB, HTML, and done within 5 seconds.

### Keys

- Secrets live in Wrangler secrets and `.env`, never in `VITE_` variables (the
  README's rule): `MAPBOX_SERVER_TOKEN`, `YOUTUBE_API_KEY`, the markets key, a
  paid weather key.
- The Mapbox public token is public by design and restricted by URL.

### Location and third parties

- Location as described under [Maps](#maps): coarse by default, precise only with
  permission, rounded, never stored unasked.
- YouTube loads nothing until a video is played.
- Mapbox GL reports map loads to Mapbox for billing. That is the price of the live
  map, and the privacy notes in the README should say so.

### A content security policy

The site sends none today. When one is added it must allow Mapbox (`worker-src
blob:`, `connect-src` to `*.mapbox.com` and `events.mapbox.com`, images from
`*.mapbox.com` and `i.ytimg.com`) and frames from `www.youtube-nocookie.com`.

### Licences and attribution

| Source | Terms to honour |
| --- | --- |
| Mapbox | logo and attribution visible on every live map and still |
| Open-Meteo / MET Norway | CC BY 4.0 credit in the card's sources; Open-Meteo's non-commercial limit |
| World Bank, Our World in Data | CC BY 4.0 credit |
| Wikidata | CC0; no credit required, given anyway as a source |
| Wikipedia pictures | the credit line cards already carry |
| YouTube | official embedded player only; embeddable videos only |
| ECB rates (Frankfurter) | shown as reference rates, with their date |

## Performance budgets

| Budget | Limit |
| --- | --- |
| Main bundle growth | at most 15 KB gzipped; blocks load with the stage |
| Chart kit | at most 25 KB gzipped, loaded with the first chart |
| Mapbox GL | never in the main bundle; loaded on the first map block, fetched early on a pending `show_map` |
| WebGL contexts | two: the room and one map |
| Refracting surfaces on the stage | the front card or spread, and lenses |
| DOM per card | at most 1,500 nodes |
| Card frame / patch | 64 KB / 32 KB |
| Materials per session on the server | 2 MB |

Time from tool call to card, as targets to measure against:

| Skill | p50 | p90 |
| --- | --- | --- |
| `weather` | 1.2 s | 2.5 s |
| `show_map` place, map already loaded | 1.2 s | 2.5 s |
| `show_map` place, first map of the session | 2.5 s | 4 s |
| `show_map` route or nearby | 1.5 s | 3 s |
| `show_video` | 1.5 s | 3 s |
| `research` card | brief + 2.5 s | brief + 5 s |
| `craft`, materials in hand | 2.5 s | 5 s |

Workers on the free plan may make 50 external subrequests per invocation, and on
a paid plan 10,000. A deep research turn with its data tools can come near 50, so
the latency panel counts subrequests per turn from Phase 1 on.

## Measuring it

### In `npm test`, no network

- the schema, pointer resolution and every derive;
- grounding: numbers, verbatim quotes, dates, one unit per row;
- each recipe's minimums and fallback chain;
- downsampling keeps first, last, peak and low;
- chapter parsing; geocode ambiguity; route simplification;
- mention matching, including the "points at too much" rule;
- the adapter for today's cards;
- well and ink contrast recomputed from `PALETTES`;
- every block rendered from fixtures, with keyboard sorting and point stepping;
- frame ordering: a patch before its card, after `done`, for a guess that is
  discarded, and for a card no longer on screen (extending
  `src/lib/research-stage.test.ts`).

### Live benchmarks, run on purpose

They spend money, so check the OpenRouter credit before running them.

| Script | Answers | Gate |
| --- | --- | --- |
| `benchmark:routing` | does the speaking model pick the right tool, and no tool when none fits | 95% overall, 92% precision and 90% recall per tool, zero stray side effects |
| `benchmark:compose` | 60 fixtures of brief and materials: the right recipe, a valid card, no invented value | 90% right recipe; 100% valid; zero grounding violations over 5 runs each |
| `benchmark:director` | 40 screen commands: the right control with the right value | 90% right; zero invalid controls applied |
| `benchmark:skills` | time to card and success for each skill | the targets above |
| `benchmark:models` (exists) | time to first token as tools are added | at most 60 ms slower at the median |

Any grading that needs a model uses `openai/gpt-5.6-luna`.

### The lab

`/lab/cards`, a development-only route, draws every recipe at every size from
fixtures, over each of the six moods, beside a striped test pattern for judging
the glass (the same trick used to tune the refraction). Every phase ends with a
screenshot pass of the lab.

## Phases

Estimates are focused days for one person, and rough.

### Phase 0: groundwork (4 days)

- `CardV2`, materials, the pointer resolver and the adapter for today's cards.
- `ResearchStage.tsx` split into the stage, the card frame, recipes and blocks,
  with today's five kinds rebuilt as recipes.
- Protocol version 3 with `card_patch`, and the frame bounds.
- The lab route and its fixtures.
- **Exit:** every existing test passes; today's cards look the same in the lab
  drawn through `CardV2` as they do now; `benchmark:cards` is no worse.

### Phase 1: richer research cards (10 days)

- Blocks: `table`, `chart`, `timeline`, `stat`, `note`, `prose`, `quote`,
  `chips`, `list`, `steps`.
- Sizes `glance`, `wide` and `feature`, and the peek rule.
- The composer with pointers; materials captured in the desk; `entity_facts`,
  `country_data`, `chart_data`, `page_data`.
- Recipes: `profile`, `figure`, `compare`, `trend`, `ranking`, `timeline`,
  `steps`, `front-page`, `feature`, `recipe`; `research` gains `depth`.
- Mentions, the digest, the eyes following, desk progress on the searching pane.
- **Exit:** `benchmark:compose` gates pass; `benchmark:routing` holds today's
  cases and the new research shapes; the contrast test passes; research cards land
  within brief + 2.5 s at the median.

### Phase 2: weather (3 days), and markets once a provider is chosen (2 days)

- `weather` with the provider interface, coarse location from `request.cf`, the
  weather spread, the UV meter, freshness and refresh.
- `markets` with currencies first, then the chosen provider.
- **Exit:** weather within 1.2 s at the median; `weather` against `research`
  confusions at 97% or better in the corpus; the market card shows its delay and
  no advice in 20 scripted questions.

### Phase 3: maps (6 days)

- Tokens, the lazy chunk and early fetch, the one-map pool, the Standard style
  tuned in the lab, stills.
- `show_map` in all three modes; `get_location`; map blocks on profile and place
  cards; list and pin in step; map controls.
- **Exit:** map tools at 95% precision with zero map calls in the figures of speech;
  ten ambiguous names asked about, none guessed; place card within 2.5 s cold and
  1.2 s warm; never more than two WebGL contexts; attribution visible.

### Phase 4: video (5 days)

- The echo spike first, then `show_video`, the cache and the fallback, the poster
  and player, chapters, controls, and whatever the spike decides for the
  microphone.
- **Exit:** `show_video` only on real video requests (95% precision, and every
  "how do I" in the corpus stays with research); zero false turns in the
  three-minute test; quota used per day on the latency panel.

### Phase 5: the screen as a workspace (7 days)

- The stage director with controls; `craft` by voice and by dragging; spreads;
  persistence and refresh; the memory card.
- **Exit:** `benchmark:director` gates; ten scripted crafts succeed; a reload
  restores the shelf; forgetting from the card removes the memory on the server.

### Phase 6: hardening (4 days)

- Keyboard and screen reader pass over every block; reduced motion; a profile on
  a mid-range laptop and a phone; frame size audit; error states; subrequests and
  quotas on the latency panel.
- README and RESEARCH_STAGE.md updated with the measured numbers, dated, the way
  every other number in them is.

About 41 days in all. Phases 2, 3 and 4 depend on Phase 0 and on the chart block
from Phase 1, and not on each other, so they can run in any order or at once.

## Decisions that are yours

1. **Mapbox tokens.** Create a URL-restricted public token and a secret server
   token, and confirm the account's plan.
2. **Weather provider.** Is chatgideon.com commercial (ads, subscriptions, a
   business)? That decides Open-Meteo's free API or MET Norway.
3. **Markets.** A stock data provider and budget, or currencies only for now.
4. **YouTube.** A Google Cloud project for a Data API key (100 searches a day
   free), or Exa-only discovery without durations and chapters.
5. **Cloudflare plan.** Free allows 50 external subrequests per invocation, which
   rich research turns can approach.
6. **Composer model.** `openai/gpt-5.6-luna` by default. If it misses the card
   budget, whether to keep `gpt-4.1-mini` for composing instead.
7. **Video and the open microphone.** Whether needing GIDEON's name or a tap during
   playback is acceptable, if the spike shows it is needed.
8. **The masthead.** "GIDEON · Evening edition" as proposed, or a name of its own.
9. **Sports.** Now, later, or not at all.

## Risks

| Risk | Why it matters | What contains it |
| --- | --- | --- |
| Routing gets worse as tools are added | the wrong skill is a visible, spoken mistake | generated descriptions, the boundary table, the corpus gate |
| Longer prompt slows the first word | the one number a person feels | the 60 ms gate on `benchmark:models` |
| The composer invents structure | a confident wrong table | pointers, JSON schema, the validator, fallbacks |
| The desk slows with more tools | silence after the holding line | parallel calls in one round, desk timings per phase, the existing hedge |
| Dense content is unreadable over the room | the glass fails its only job | wells at 74% and the contrast test |
| WebGL contexts or GPU memory run out | a blank map, a lost shader | one map, stills everywhere else |
| Phones struggle with glass, shader and map together | stutter on the device people hold | refraction already Chromium-only; lower the room's frame rate while a map is live |
| Video audio starts turns | GIDEON interrupts a video with nobody speaking to it | the spike and its gate |
| Licence terms change or are breached | a provider shuts the key | the licences table, attribution on every card |
| Free-plan subrequest cap | a rich turn fails partway | counted per turn; the plan decision above |
| Scope creep across twenty recipes | nothing ships | phases with exits; "no card" stays the default |
| Other work in the same files | merge collisions while several sessions edit | new files wherever possible; block styles in `src/styles/cards.css`, imported by one line |

## Files

### New

```text
src/lib/cards/
  schema.ts         CardV2, blocks, sizes, controls, mentions
  materials.ts      material kinds and source references
  pointers.ts       pointer grammar and resolution
  derive.ts         change, percent change, CAGR, rank, distance
  ground.ts         today's number checks, plus quotes, dates and units
  recipes.ts        recipes: needs, sizes, fold budgets, fallbacks
  mentions.ts       the spoken-sync index
  digest.ts         a card in 400 characters
  legacy.ts         today's card into CardV2
  downsample.ts     largest-triangle-three-buckets
  geometry.ts       route simplification, great-circle distance
src/lib/skills/
  manifest.ts       the manifest type and description generator
  weather.ts  maps.ts  video.ts  markets.ts  craft.ts  memories.ts
  desk/entity-facts.ts  desk/country-data.ts  desk/chart-data.ts  desk/page-data.ts
  routing.live.test.ts  routing-corpus.ts
src/lib/tools/composer.ts           the composer call and its schema
src/components/stage/
  Stage.tsx  CardFrame.tsx  RecipeLayout.tsx  SearchingFace.tsx  Lightbox.tsx
  blocks/     one component per block
  charts/     LineChart.tsx  BarChart.tsx  RangeChart.tsx  Sparkline.tsx  scales.ts
  map/        MapBlock.tsx  map-pool.ts  still.ts
  video/      VideoBlock.tsx  youtube-player.ts
src/routes/lab.cards.tsx            development only
src/styles/cards.css                block styles, imported by styles.css
```

### Changed

```text
src/lib/cards.ts               re-exports from cards/ while callers move
src/lib/tools/card-builder.ts  keeps the Wikipedia portrait and the card cache; composing moves out
src/lib/tools/research.ts      captures materials; desk tools; depth
src/lib/tools/registry.ts      schemas generated from manifests
src/lib/agent-core.ts          card_patch; digest in the prompt; new tools' holding lines
src/lib/stage-judge.ts         becomes the stage director
src/lib/protocol.ts            version 3
src/lib/realtime-client.ts     card_patch, controls, get_location
src/components/AgentPage.tsx   stage wiring, persistence, crafting by drag
src/components/StageShelf.tsx  stills for map and video cards
backend/worker/src/server.ts   coarse location from request.cf
.env.example, backend/worker/.dev.vars.example, wrangler.jsonc   new settings
```

## Appendix A: a skill manifest

```ts
export const weather: SkillManifest = {
  tool: 'weather',
  job: 'The forecast or the conditions now for one place, up to the forecast horizon.',
  useWhen: [
    'what the weather is or will be somewhere, today or on a day inside the horizon',
    'rain, snow, wind, temperature, UV, sunrise or sunset at a place and time',
    'whether to take a coat, an umbrella or sunscreen',
  ],
  neverFor: [
    { when: 'what a place is like in a season, or its climate', use: 'research' },
    { when: 'the weather on a past date, or past the horizon', use: 'research' },
    { when: 'figures of speech such as "under the weather"', use: null },
  ],
  examples: ['will it rain in Lisbon tomorrow', 'how cold is it tonight', 'do I need sunscreen this afternoon'],
  counterExamples: [
    { text: 'what is Lisbon like in April', use: 'research' },
    { text: 'I feel under the weather', use: null },
  ],
  parameters: {
    type: 'object',
    properties: {
      place: { type: 'string', description: 'The place as the user said it. Leave out for where the user is.' },
      day: { type: 'string', description: "'today', 'tomorrow', a weekday, or a date inside the horizon." },
    },
    required: [],
  },
  readOnly: true,
  needs: [],
  recipes: ['weather', 'figure'],
  budget: { p50Ms: 1200, p90Ms: 2500 },
  voice: 'The card shows the details. Say the one or two things that matter, such as rain later or a cold night.',
}
```

The description generated from it reads:

> The forecast or the conditions now for one place, up to the forecast horizon.
> Use it for what the weather is or will be somewhere, today or on a day inside
> the horizon; rain, snow, wind, temperature, UV, sunrise or sunset at a place and
> time; whether to take a coat, an umbrella or sunscreen. Never use it for what a
> place is like in a season or its climate (use research), or the weather on a
> past date or past the horizon (use research). The card shows the details. Say
> the one or two things that matter, such as rain later or a cold night.

### Checklist for adding a skill

1. Write the manifest, including `neverFor` with the tool that should be used
   instead.
2. Add its rows to the boundary table, then to the corpus, both sides of every
   pair.
3. Write its argument guard and the one-sentence refusals.
4. Write its recipe, with needs and a fallback chain, and fixtures in the lab.
5. Add unit tests and a live benchmark with a time budget.
6. Run `benchmark:routing` and `benchmark:models`, and record the numbers with the
   date in RESEARCH_STAGE.md.

## Appendix B: the routing corpus

| Group | Cases |
| --- | --- |
| New tools, plain requests: `weather` 15, `show_map` 30 (10 per mode), `show_video` 15, `markets` 15, `craft` 10, `show_memories` 8 | 93 |
| Existing tools: `research` 20, `show_images` 12, memory 10, `set_timer` 6, `offer_link` 4, `get_time` 3 | 55 |
| Both sides of every boundary pair, with paraphrases | 50 |
| Figures of speech and small talk that need no tool | 20 |
| Screen commands with cards on screen, which need no tool | 15 |
| Two requests in one sentence ("weather in Rome, and show it on a map") | 7 |
| **Total** | **240** |

Each case records the utterance, the cards on screen if any, the expected tool
(or none), and for `show_map` and `research` the expected mode or recipe.

## Sources checked

Checked on 13 September 2026.

- Mapbox GL JS on npm: version 3.30.0, published 3 September 2026
  ([registry.npmjs.org/mapbox-gl](https://registry.npmjs.org/mapbox-gl)).
- Mapbox Standard's themes (default, faded, monochrome) and colour configuration
  ([docs.mapbox.com/map-styles/guides/standard-styles](https://docs.mapbox.com/map-styles/guides/standard-styles/));
  `setConfigProperty` and `lightPreset`
  ([docs.mapbox.com/mapbox-gl-js/example/set-config-property](https://docs.mapbox.com/mapbox-gl-js/example/set-config-property/)).
- Mapbox Search Box category search
  ([docs.mapbox.com/api/search/search-box](https://docs.mapbox.com/api/search/search-box/)).
- Mapbox free allowances, as summarised in 2026 pricing guides
  ([woosmap.com/blog/mapbox-pricing](https://www.woosmap.com/blog/mapbox-pricing),
  [apicostcalc.com/mapbox.html](https://apicostcalc.com/mapbox.html)); confirm on
  the account's own pricing page before relying on them.
- Open-Meteo terms and pricing ([open-meteo.com/en/terms](https://open-meteo.com/en/terms),
  [open-meteo.com/en/pricing](https://open-meteo.com/en/pricing)).
- MET Norway terms of service and Locationforecast 2.0
  ([docs.api.met.no/doc/TermsOfService](https://docs.api.met.no/doc/TermsOfService),
  [api.met.no/weatherapi/locationforecast/2.0/documentation](https://api.met.no/weatherapi/locationforecast/2.0/documentation)).
- YouTube Data API quota
  ([developers.google.com/youtube/v3/getting-started](https://developers.google.com/youtube/v3/getting-started)).
- Cloudflare Workers limits and the subrequest change
  ([developers.cloudflare.com/workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/),
  [changelog, 11 February 2026](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/));
  the 32 MiB WebSocket message limit
  ([changelog, 31 October 2025](https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit/)).
- Our World in Data chart API ([docs.owid.io/projects/etl/api/chart-api](https://docs.owid.io/projects/etl/api/chart-api/)).
- Exa search categories, including `news` with a start date
  ([exa.ai/docs/reference/search](https://exa.ai/docs/reference/search)).
- Frankfurter ([frankfurter.dev](https://frankfurter.dev/)).
