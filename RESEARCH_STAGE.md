# The research stage

> Design and build notes for showing what GIDEON finds out, on screen, while it
> says it. The first revision was designed before it was built. The second
> (pictures, the shelf, the resources panel and the wider stage) followed the
> first round of use.

## What it should feel like

You ask about Einstein. GIDEON says "Let me look that up", and its eyes leave
the middle of the room: they dip toward the bottom left, sweep up into the top
left corner, and settle there, smaller, looking at the space they just cleared.
On a wide screen the conversation and the controls follow them into a column
down the left, and the rest of the screen becomes the stage. A pane of glass
forms there with your question on it while the search runs. When the answer
comes back the pane becomes a card: his portrait, his name, one line about who
he was, and four or five facts, each brightening as GIDEON says it.

Ask to see chocolate cake, and the pane fills with photographs instead: one
large picture with a grid around it. Tap any of them to see it full size.

Ask something else that needs looking up, and the current card steps back to
the right edge, half visible, while the new one forms in the middle. Tap the
one at the edge to bring it forward again.

Talk about something unrelated, and every card slides off to the right edge,
where they wait as a column of tabs. The eyes and the controls glide back to the
middle of the room. Come back to Einstein ("how old was he when he died?") and
his card comes back by itself, and the eyes go back to the corner to look at
it. Pressing a tab does the same.

Saying "that's all", Escape, or the close button put the cards on the shelf the
same way. Nothing is thrown away until you start a new conversation.

## The transcript

Two things were wrong with the line that shows what you are saying.

1. **It could disappear entirely.** The transcript added a placeholder `•••`
   for GIDEON's reply whenever the last message in history was yours. That is
   also true after a reply fails, after you stop one, and after you cut GIDEON
   off before a word of it was heard. In each case the next thing you said was
   hidden behind a `•••` for a reply that was never coming. The placeholder now
   appears only while a turn is actually in flight.
2. **It jumped rather than rose.** The transcript pins itself to its floor with
   an instant scroll, deliberately, because an animated scroll reads as the
   reader scrolling away. The rise is done with a transform instead. When the
   lines grow, they start shifted down by exactly the growth and glide to rest,
   so the scroll logic is untouched and the older lines move up smoothly. Your
   own words arrive one by one, the way GIDEON's do, and starting to speak
   always brings the transcript back to its floor.

## Layout

```text
Conversation, cards on the shelf           Stage open, wide screen
+-----------------------------------+      +--------------------------------------+
| GIDEON          [Resources] [New] |      | (o o)            [Resources] [New]   |
|                                 [▌|      |           +-------------------+ +--+ |
|             (o   o)             [▌|      | you: ...  | [img] | Title     | |pe| |
|                                 [▌|      | gideon:   |       | Subtitle  | |ek| |
|        you: tell me a joke        |      |   ...     |       | fact fact | |  | |
|        gideon: ...                |      |           +-------------------+ +--+ |
|            (mic) [type]           |      | (mic) [type.......]                  |
+-----------------------------------+      +--------------------------------------+
```

- **Wide screens, 1000 px and up.** A column 300 to 380 px wide holds the docked
  eyes at the top, the conversation under them, left-aligned, and the controls
  at the bottom. The stage takes everything else, top to bottom, so a card can
  be up to 960 px wide. The controls and the conversation glide between the
  column and the middle of the room as the stage opens and closes.
- **Narrow screens.** Stacked: the card on top, the last lines of the
  conversation under it, the controls at the bottom, and the eyes docked above
  the card. The peeking card shows a 14 px sliver.
- **Shelf.** Up to five tabs at the right edge, newest at the top, each showing
  its picture or initial. Pointing at a tab slides it out far enough to read.
- **Resources.** One button in the top-right corner, with a count.

## The card

One component with five arrangements, chosen by what the answer is, not by a
fixed template.

| Kind | When | Arrangement |
| --- | --- | --- |
| `entity` | a person, place, organisation, work or thing | portrait image on the left, title, subtitle, a one-line summary, then 3 to 5 label and value facts |
| `figure` | the answer is one number: a price, a score, a temperature | the number set large, what it measures under it, then a line of context and 2 to 3 facts |
| `news` | an event with a date | date as a kicker, headline, summary, the story's own picture |
| `answer` | anything else | title, summary, facts |
| `gallery` | pictures were asked for | a large lead picture in a grid that every count fills without gaps; tap one to see it full size, with arrows between them |

Every card ends with its sources as small chips (the site name, which opens the
page in a new tab). A card is only shown when it would help: the builder can
say "no card", and does when the research found nothing, when the answer is a
yes or a no, or when the brief is too thin to fill one.

### The material

Liquid glass, in layers, from the back:

1. `backdrop-filter: blur(30px) saturate(175%)`, so the room's colour shows
   through, softened.
2. A fill of white at 10% fading to 3% across the diagonal.
3. A rim: a 1 px border drawn with a conic gradient, brighter where the light
   catches it, like a nickel edge.
4. A specular sheen that follows the pointer across the surface.
5. An inner highlight along the top edge, and a soft shadow that makes it float.

Each card is three nested layers, and only the innermost one ever fades or
blurs. Opacity or a filter on an ancestor would cut the glass off from the room
behind it, and the blur would be of nothing.

## Motion

| Moment | What moves | Timing |
| --- | --- | --- |
| Eyes dock | the face travels to the corner through a waypoint low on the left, shrinking as it goes; across and down run on different curves, which is what makes it a swoop; the gaze leads the path | 1150 ms |
| Searching pane forms | scale 0.94 to 1, blur 18 px to 0, rising 16 px | 760 ms |
| Card fills in | image unblurs, then each line rises in turn | 80 ms apart |
| Fact spoken | the row brightens, and its value gains a glow | 400 ms |
| New card arrives | the current card slides to the right edge and dims; the new one forms in place | 780 ms |
| Cards step aside | every card slides toward the right edge, shrinking and fading, then the shelf tabs slide in and the eyes go home | 560 ms, then 950 ms |
| Controls move | the controls and the conversation glide between the column and the middle | 720 ms |

Reduced motion replaces every travel with a cross-fade and turns off the bob,
the tilt and the sweep.

## Where a card comes from

```text
user asks ─► chat model calls research(question)
                 │
                 ├─► "action pending" frame carrying the question ─► searching pane
                 ▼
             research desk returns the brief and its sources
                 │
                 ├─► brief goes back to the chat model, which starts speaking
                 └─► card builder, beside the spoken answer
                        1. a fast model turns the brief into card JSON
                        2. validation: lengths clipped, at most five facts, and
                           any number the brief does not state is removed along
                           with whatever carried it
                        3. for an entity, a Wikipedia portrait, only when the
                           article is surely the right one
                        4. a `card` frame, or `card: null` when there is none
```

The card never delays the voice. Measured on 11 September 2026 with
`gpt-4.1-mini` (`npm run benchmark:cards`, two runs of four briefs): every card
was the right kind, the brief that had found nothing drew no card, and no card
stated a number its brief did not. A card took 1.6 to 8 seconds, about 2.7 at
the median. Routing that call by throughput rather than by first-token latency
brought the slow end down from a timeout past 9 seconds, because nothing is
shown until the whole object has arrived.

Which questions get a card is the speaking model's call, steered by its prompt:
anything current, and any particular person, place, organisation, work or
event, even a famous one, because the card is part of the answer. In the first
live run, "who was Marie Curie" was answered from memory with no card at all;
the prompt now names it as an example. Measured with
`npm run benchmark:research`: the weather, a race result, a price, Marie Curie
and the Eiffel Tower all went to research, and arithmetic, a joke and small
talk did not, eight of eight.

## Pictures

The chat model calls `show_images` when it is asked to see pictures of
something, or what something looks like. The prompt tells it never to answer
with a link to an image search instead, which is what it did before the tool
existed.

Where the pictures come from was settled by experiment on 11 September 2026:

- **Exa** reports each page's own lead picture once any contents are asked for,
  and a query ending in "photos" finds photo pages (Unsplash, Pexels,
  Wikimedia), whose lead picture is the photograph itself. Asking for the
  pages' image links was the fastest option, at about 0.7 seconds.
- **Openverse**, which needs no key, tops the gallery up with openly licensed
  photos, mostly from Flickr, when the web gave fewer than six.
- **Wikimedia Commons** would be the obvious third source, but it did not
  resolve from the development machine, so nothing depends on it.

A gallery is judged by its worst tile, so the filtering is strict: no site
logos, icons or placeholders; nothing from stock libraries (iStock,
Shutterstock, Getty and the like), whose previews are watermarked, or from
Canva; never the same photograph twice; and Unsplash and Pexels sharing
previews, which are cropped and stamped with a logo, are traded for the
photograph at the size each place needs. A picture that will not load is taken
out and the grid is laid out again without it, and so is one that arrives
smaller than 320 by 200 or shaped like a banner: in the first live run a site's
language flag got through as its "picture", and nothing in its address said so.

The speaking model is told how many pictures are showing and from where, and is
asked for one line about them, never a description of each.

## Keeping the screen in step with the talk

The first revision had a `clear_screen` tool for the model, which cost a full
model round trip every time it was used, and nothing brought a card back. It is
replaced by a judgement that runs beside the reply, never in front of it:

1. Each turn tells the server what is on screen: the cards, and which one, if
   any, is open.
2. A small model call (`gpt-4.1-mini`, at most 40 tokens out) reads the cards
   and the last six messages and says which card, if any, the latest message
   is about, and whether it asks to close the screen. What the screen does
   follows in code: about the open card, nothing changes; about another card,
   that card comes forward; about none, the cards step aside. Asked for the
   move itself, with "when unsure, keep", the model kept everything put away
   even when the talk came straight back to it: two of six live cases wrong,
   both of them the returns. Asked only what the message is about, and matched
   by the card title it answers with, it got all six
   (`npm run benchmark:judge`).
3. The answer is held until the first round of the reply shows what the turn
   does. A turn that puts something new on screen (research or pictures)
   settles the question itself, so the judgement is dropped; stepping aside a
   moment before a new card arrives would send the face away and straight back.
4. The browser applies it only if it is about the newest turn. A judgement
   about an older one describes a conversation that has already moved on.

The browser also recognises the obvious phrases itself ("that's all", "I'm
done", "close it", "never mind", "something else") so the cards go the moment
the sentence ends. The speaking model is told what is on screen too, so "the
second one" and "what does the card say" can be answered. Asking for the same
thing twice (the same kind of card with the same title) replaces the earlier
card instead of leaving two of it on the shelf.

## Resources

Everything GIDEON did and read used to be listed under the conversation, and it
grew with every search until it crowded out the conversation it described. It
is now behind one button in the corner, with a count that brightens when
something new has arrived. The panel is grouped by what was asked, newest
first, with the pages each answer came from. Escape closes it before it reaches
the cards. An offered link opens the panel itself, since GIDEON has just said
it is on screen.

## Protocol

- The `turn` frame (and the HTTP body) carries `screen`: the cards on screen and
  which one is open. The server reads it as untrusted input, bounded to twelve
  cards.
- `action` frames for `research` and `show_images` carry `detail`, the question
  asked, on both the pending frame and the result.
- `{ t: 'card', id, call, card }`, where `card` may be null. It can arrive after
  `done`, so the browser handles it apart from the turn's own handlers, and holds
  it back for a speculative turn until that turn is promoted.
- `{ t: 'stage', id, op: 'tuck' }` and `{ t: 'stage', id, op: 'show', card }`,
  held the same way.

## Needs

`EXA_API_KEY` in `.env` and in the Worker's secrets. Without it, research is not
offered at all, and pictures come from Openverse alone.

## Later

- Hedge the card call: past about four seconds, race a second request, the way
  the research desk hedges a slow run.
- Stream the research desk's progress onto the searching pane ("Searching:
  Einstein biography", "Reading britannica.com").
- Remember the shelf across a reload.
