/** Offer code generation only after a drawing request or acceptance of an offer. */
export function illustrationRequested(messages: readonly { role: string; content: string }[], screen?: { front: string | null; cards: readonly { id: string; kind: string }[] } | null): boolean {
  const latest = messages.filter(message => message.role === 'user').at(-1)?.content.trim() ?? ''
  if (/^(?:picture this|imagine this)\s*:/i.test(latest)) return false
  const drawing = /\b(draw|sketch|doodle|illustrate|illustration|diagram|interactive|anatomy|paint|blueprint|infographic|flowchart|visual explainer)\b/i
  if (drawing.test(latest)) return true
  if (/^(yes|yeah|yep|sure|ok|okay|please|go ahead|do it|try again|sounds good)\b/i.test(latest)) {
    const offer = messages.filter(message => message.role === 'assistant').at(-1)?.content ?? ''
    if (drawing.test(offer)) return true
  }
  return Boolean(screen?.cards.some(card => card.id === screen.front && card.kind === 'illustration') && /\b(change|make|add|remove|redraw|simplify|colour|color|rotate|animate)\b/i.test(latest))
}
