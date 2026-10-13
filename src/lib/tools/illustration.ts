import { readIllustrationHtml } from '../illustrations/validation'
import { cardDeps, type CardDeps } from './card-builder'
import type { ToolContext, ToolOutcome } from './registry'
import type { CardV2 } from '../cards/schema'

/** Drawing code is authored separately from the low-latency speaking model. */
export const DEFAULT_ILLUSTRATION_MODEL = 'anthropic/claude-sonnet-4.6'
export interface IllustrationDeps extends CardDeps { trace?: (event: Record<string, string | number>) => void }

export const ILLUSTRATION_PROMPT = `Build one self-contained interactive drawing for the user's request. Return JSON only: {"title":string,"summary":string,"html":string}.
html is a body fragment with inline CSS, SVG and vanilla JavaScript. No html/head/body/meta elements, imports, external libraries, fonts, images, links, forms or network calls. No React. Fit a 390px phone and a 900px desktop with no horizontal overflow. Keep the fragment below 60000 characters.
Use Anatomy's crafted drawing style inside the canvas, with paper, blueprint, sepia, dark or a user-requested palette. Gideon's existing liquid-glass interface wraps this canvas; do not build or restyle the host interface. Put a short title, a visible interaction hint, controls, a live readout and a truthful caption around the drawing. Include an initial static SVG so failure of animation does not leave a blank screen.
For technical explainers apply Anatomy: the object IS the explanation. Invent a recognisable physical mechanism whose motion maps to the concept. One isometric camera, filled solids, four tones by facing, one accent on the part to watch, back-to-front painter's order. Build purposeful screws, feet, rails, collars, ticks and connectors, aiming for 40 parts for one mechanism. Avoid floating boxes and arrow diagrams unless the user requests that style. For other drawing requests follow the user's subject and style.
A real geometry kit is preloaded as window.Anatomy, with its ISO_CSS already installed. Use const k=window.Anatomy. APIs:
fitProjection(points,width,height,{pad:30,azimuth:45,elevation:30}) gives P. A plan is {x,y,w,d,r}. boxCorners(plan,z0,z1) supplies fit bounds. iso([x,y,z],P) gives screen [x,y]; depthOf([x,y,z],P) gives painter's depth, sort ascending.
slabOf(plan,z,height,P,steps=8,bevel=0) and cylinder(cx,cy,radius,z,height,P,steps=40) return one paths object, NOT SVG and NOT an array. height is thickness, not the top z coordinate. Example: k.solidSvg(k.slabOf({x:-100,y:-50,w:200,d:100,r:6},0,10,P),{tone:'mid'}). solidSvg(paths,{tone:'mid',lit:false}) returns SVG markup; tone is only hi, mid, lo or faint. ring(cx,cy,radius,z,P,steps=40), planOutline(plan,z,P), lineSvg(path,{tone:'lo'}), dotsSvg(screenPoints,{size:0.5}), corners(plan,inset=0), insetPlan(plan,amount), translateAlong(P,[dx,dy,dz]) returns a transform string. topTicks(from,to,step,every,edge,z,[short,long],P) returns {minor,major}; radialTicks(cx,cy,r,count,every,z,[short,long],P) returns {minor,major}.
Wrap kit SVG in an ancestor class='iso' data-theme='light' or 'dark', SVG class='iso-svg' with viewBox and role='img' aria-label. Override --anatomy-* variables on .iso for your own palette. Reuse static geometry; update only moving groups. Escape text before inserting it into SVG.
Keep projection P in the closure of custom drawing functions, rather than passing it positionally. Check that every helper call matches its declared arguments. SVG height must be a number or omitted, never the attribute height='auto'; use CSS for responsive sizing. Use ordinary spaces in text and no control characters.
The kit's paths objects are opaque: fill, top, outline and crease are SVG PATH STRINGS, and shades is an array of path strings. Never treat a path string as a list of points, map over a face, or rotate projected path strings. To rotate a solid, rotate its world-space [x,y] polygon points first, then call k.extrude(points,z,height,P,{convex:true}). Extrude returns the same opaque paths object as slabOf. Pass that directly to solidSvg. Use native keyboard behaviour on range inputs; if you implement custom key handlers, prevent the native default to avoid doubling the step.
Use one pure model for motion, numbers and explanation. All invented values MUST be labelled illustrative, not measurements or verified facts. Never invent current data or pretend to have researched it. State simplifications in the caption. If the question demands sourced charts or exact specifications rather than a conceptual model, it belongs to research.
Controls must work with pointer and keyboard using real buttons and labelled range inputs. Give the readout aria-live='polite'; update it on input, not every animation frame. Support Reset. Respect prefers-reduced-motion in JS as well as CSS: no idle animation then, controls still work. Stop animation when document.hidden. Use requestAnimationFrame and dt-based easing, no fast flashing. Do not use parent, top, storage, cookies, fetch, location, window.open, service workers or eval.
summary is two short sentences describing the mechanism and its limitations, with no claims about current control positions. This is a first draft, not an engineering simulation. Produce a complete, working small figure in one pass.`

export async function generateIllustration(request: string, deps: IllustrationDeps, signal: AbortSignal): Promise<CardV2 | null> {
  if (!deps.openrouterHeaders || signal.aborted) return null
  const response = await deps.fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: deps.openrouterHeaders,
    signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    body: JSON.stringify({ model: deps.model, messages: [{ role: 'system', content: ILLUSTRATION_PROMPT }, { role: 'user', content: request }], response_format: { type: 'json_object' }, max_tokens: 12_000, reasoning: { enabled: false }, temperature: 0.35 }),
  })
  deps.trace?.({ status: response.status })
  if (!response.ok) return null
  const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> }
  const choice = payload.choices?.[0]
  deps.trace?.({ finish: choice?.finish_reason ?? 'missing', characters: choice?.message?.content?.length ?? 0 })
  if (choice?.finish_reason !== 'stop') return null
  let value: unknown
  try { value = JSON.parse((choice.message?.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { deps.trace?.({ rejected: 'json' }); return null }
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const html = readIllustrationHtml(raw.html)
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 100) : ''
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 800) : ''
  if (!html || !title || !summary || signal.aborted) { deps.trace?.({ rejected: 'document', htmlCharacters: typeof raw.html === 'string' ? raw.html.length : 0 }); return null }
  return { schema: 2, recipe: 'illustration', size: 'feature', query: request.trim().slice(0, 240).trim(), title,
    blocks: [{ id: 'drawing', slot: 'body', type: 'illustration', title, summary, html }], sources: [], asOf: null, partial: false }
}

export async function runIllustration(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const request = typeof args.request === 'string' ? args.request.trim().slice(0, 4_000) : ''
  if (!request) return { ok: false, content: 'No drawing request was given.' }
  const deps: IllustrationDeps = cardDeps(context.env)
  deps.trace = event => context.audit?.record('illustration_provider', event)
  deps.model = context.env('OPENROUTER_ILLUSTRATION_MODEL')?.trim() || DEFAULT_ILLUSTRATION_MODEL
  try {
    const card = await generateIllustration(request, deps, context.signal)
    context.audit?.record('illustration_generation', { model: deps.model, ok: Boolean(card), characters: card?.blocks[0]?.type === 'illustration' ? card.blocks[0].html.length : 0 })
    if (card) return { ok: true, summary: 'Drawing prepared', content: `Prepared an interactive drawing: ${card.title}. ${card.blocks[0].type === 'illustration' ? card.blocks[0].summary : ''} The browser will check that it renders. Say one short line inviting the user to try its controls. Do not claim the simulation is verified or that you can see its current state.`, card: Promise.resolve(card) }
  } catch {
    if (context.signal.aborted) return { ok: false, content: 'The drawing was cancelled.' }
    context.audit?.record('illustration_generation', { model: deps.model, ok: false })
  }
  return { ok: false, summary: 'Could not prepare the drawing', content: 'The drawing could not be prepared this time. Say so briefly; do not claim a drawing appeared. Offer a smaller mechanism or another attempt.' }
}
