# The research stage

> Design and build plan for showing what GIDEON finds out, on screen, while it
> says it. Written before the code, and built in the order of the steps below.

## What it should feel like

You ask about Einstein. GIDEON says "Let me look that up", and its eyes leave
the middle of the room: they dip toward the bottom left, sweep up into the top
left corner, and settle there, smaller, looking at the space they just cleared.
A pane of glass forms in that space with your question on it while the search
runs. When the answer comes back the pane becomes a card: his portrait, his
name, one line about who he was, and four or five facts. As GIDEON speaks, each
fact brightens when its words are said.

Ask about something else, and the Einstein card steps back to the right edge,
where it waits, half visible, while the new card forms in the middle. Tap the
one at the edge and it comes forward again.

Say "that's all" and the cards dissolve, newest first, and the eyes glide back
to the middle of the room.

## Before any of that: the transcript

Two things were wrong with the line that shows what you are saying.

1. **It could disappear entirely.** The transcript adds a placeholder `•••`
   for GIDEON's reply whenever the last message in history is yours. That is
   also true after a reply fails, after you stop one, and after you cut GIDEON
   off before a word of it was heard. In each case the next thing you said was
   hidden behind a `•••` for a reply that was never coming. The placeholder now
   appears only while a turn is actually in flight.
2. **It jumped rather than rose.** The transcript pins itself to its floor with
   an instant scroll, deliberately, because an animated scroll reads as the
   reader scrolling away. The rise is now done with a transform instead. When the
   flow grows, it starts shifted down by exactly the growth and glides to rest,
   so the scroll logic is untouched and the older lines move up smoothly. Your
   own words now arrive one by one, the way GIDEON's do, and starting to speak
   always brings the transcript back to its floor.

## Layout

```text
Conversation (unchanged)                 Stage open
+---------------------------------+      +---------------------------------+
| GIDEON                    [New] |      | (o o)                     [New] |
|                                 |      |                                 |
|            (o   o)              |      |   +---------------------+  +--+ |
|                                 |      |   | [img] | Title       |  |pe| |
|        you: who was einstein    |      |   |       | Subtitle    |  |ek| |
|        gideon: let me look...   |      |   |       | fact · fact |  |  | |
|                                 |      |   +---------------------+  +--+ |
|            (mic) [type]         |      |      last line of transcript    |
+---------------------------------+      |            (mic) [type]         |
                                         +---------------------------------+
```

- The eyes dock in the top-left corner at roughly a third of their size. The
  brand mark fades out, since the eyes now sit where it was.
- The active card is centred in the space between the header and the
  transcript, at most 720 px wide.
- Earlier cards peek from the right edge: the nearest one shows its left 16% at
  88% scale, the one behind it less, and at most two are kept visible.
- The transcript shrinks to its last line or two. The action ledger hides,
  because the card already names its sources.
- On a phone the card takes the full width, the eyes dock small above it, and
  the peeking cards show a 12 px sliver.

## The card

One component with four arrangements, chosen by what the answer is, not by a
fixed template.

| Kind | When | Arrangement |
| --- | --- | --- |
| `entity` | a person, place, organisation, work or thing | portrait image on the left, title, subtitle, a one-line summary, then 3 to 5 label and value facts |
| `figure` | the answer is one number: a price, a score, a temperature | the number set large, what it measures under it, then a line of context and 2 to 3 facts |
| `news` | an event with a date | date and source as a kicker, headline, summary, optional image |
| `answer` | anything else | title, summary, facts |

Every card ends with its sources as small chips (the site name, which opens the
page in a new tab).

A card is only shown when it would help. The builder is allowed to say "no card"
and does so when the research found nothing, when the answer is a yes or a no,
or when the brief is too thin to fill one.

### The material

Liquid glass, in layers, from the back:

1. `backdrop-filter: blur(28px) saturate(170%)`, so the room's colour shows
   through, softened.
2. A fill of white at 9% fading to 3% across the diagonal.
3. A rim: a 1 px border drawn with a conic gradient that is brighter at the top
   left and the bottom right, the nickel edge of the pane.
4. A specular sheen that follows the pointer across the surface.
5. An inner highlight along the top edge, and a soft shadow underneath that
   makes the pane float.

The card also bobs gently, 3 px over 7 s, and tilts up to 3 degrees toward the
pointer. Text is the same GT Alpina and Frances pairing as the rest of the page:
the title in the display face, the facts in the text face, and the labels in the
monospace used for "You" and "Gideon".

## Motion

| Moment | What moves | Timing |
| --- | --- | --- |
| Eyes dock | the face travels from its place to the corner through a waypoint low on the left, shrinking as it goes; the gaze leads the path | 1100 ms, `cubic-bezier(0.65, 0, 0.35, 1)` |
| Searching pane forms | scale 0.94 to 1, blur 18 px to 0, opacity, rising 16 px | 700 ms, `cubic-bezier(0.22, 1, 0.36, 1)` |
| Searching | a band of light sweeps across the pane | 1.8 s loop |
| Card fills in | image unblurs, then title, subtitle, summary, and each fact 70 ms apart | 90 ms stagger |
| Fact spoken | the row brightens, and its value gains a glow | 400 ms |
| New card arrives | the current card slides to the right edge and dims; the new one forms in place | 650 ms together |
| Cards clear | each dissolves (blur, drop 12 px, fade), newest first, then the eyes go home | 420 ms each, 80 ms apart, then 900 ms |

While docked, the eyes stop following the pointer and look at the active card,
and they give a small reaction when a card lands. Reduced motion replaces every
travel with a cross-fade and turns off the bob, the tilt and the sweep.

## Where the card comes from

```text
user asks ─► chat model calls research(question)
                 │
                 ├─► "action pending" frame, now carrying the question ─► searching pane
                 │
                 ▼
             research desk (unchanged) returns the brief and its sources
                 │
                 ├─► brief goes back to the chat model, which starts speaking
                 │
                 └─► card builder, running in parallel with the spoken answer
                        1. a fast model turns the brief into card JSON: kind,
                           title, subtitle, summary, figure, facts, subject
                        2. strict validation: lengths clipped, at most 5 facts,
                           and any number that does not appear in the brief is
                           dropped along with the fact that carried it
                        3. for an entity, the subject is looked up on Wikipedia
                           for a portrait, and a disambiguation page or a
                           missing image means no image rather than a wrong one
                        4. sent to the browser as a `card` frame
```

The card never delays the voice. It usually lands as GIDEON's first words are
heard, because extracting it takes about as long as the spoken answer takes to
start. Cards are cached with the research they came from, so the same question
asked twice is instant.

Measured on 11 September 2026 with `gpt-4.1-mini` (`npm run benchmark:cards`,
two runs of four briefs): every card was the right kind, the brief that had
found nothing was declined, and no card stated a number its brief did not. A
card took 1.6 to 8 seconds, about 2.7 at the median. Routing the call by
throughput rather than by first-token latency is what brought the slow end
down from a timeout past 9 seconds, since nothing is shown until the whole
object has arrived.

If the builder declines or fails, the searching pane dissolves on its own, and
if there are no other cards the eyes go home.

## Closing the stage

Any of these closes it:

- **Saying you are done.** "That's all", "I'm done", "close it", "clear the
  screen", "never mind", "let's talk about something else". The browser
  recognises the common phrasings itself so the cards go the moment the sentence
  ends, and the model has a `clear_screen` tool for everything else.
- **The close button** on the stage, or **Escape**.
- **New conversation.**

## Protocol

- `action` (pending, research only) gains `detail`: the question being
  researched.
- New `card` frame, `{ t: 'card', id, call, card }`. It may arrive after `done`,
  so the browser handles it outside the turn's own handlers, and holds it back
  for a speculative turn until that turn is promoted.
- New `stage` frame, `{ t: 'stage', id, op: 'clear' }`, sent when the model calls
  `clear_screen`.

## Build steps

1. **Transcript.** Fix the hidden live line, the follow reset, the smooth rise,
   and word-by-word arrival of your own words.
2. **Card data.** `src/lib/cards.ts` for the card type, validation and the
   grounding check. `src/lib/tools/card-builder.ts` for extraction and the
   Wikipedia image. Unit tests for both.
3. **Server.** `card` and `stage` frames, `clear_screen`, and the question on the
   pending action. Agent-loop tests.
4. **Browser.** Link dispatch, stage state in the page, the `ResearchStage`
   component, the docking and the gaze of the eyes, and the glass.
5. **Verify.** Type-check, run the tests, and drive the page in a browser at
   desktop and phone sizes.

## Needs

`EXA_API_KEY` in `.env` (and in the Worker's secrets). Without it the research
tool is not offered at all, so there is nothing to put on a card.

## Later

- Hedge the card call: past about four seconds, race a second request, the
  way the research desk hedges a slow run. The slowest cards currently land
  near the end of the answer they illustrate.
- Stream the research desk's progress onto the searching pane ("Searching:
  Einstein biography", "Reading britannica.com"). The desk would need a progress
  callback, and the agent loop would need to yield while a tool is still running.
- Remember the stage across a reload.
