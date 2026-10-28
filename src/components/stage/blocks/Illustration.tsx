import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { IllustrationBlock } from '../../../lib/cards/schema'
import { draftDocument, illustrationDocument } from '../../../lib/illustrations/document'
import { readBlocks } from '../../../lib/cards/read'
import { backendHeaders, backendUrl } from '../../../lib/backend'
import './illustration.css'

/**
 * The drawing as it is being written, in a frame that grows it in place.
 * Markup goes in by message so the frame never reloads and never flashes; it
 * is the static drawing the model has put down so far, with nothing running.
 */
function DraftView({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const channel = useId()
  const nonce = useMemo(() => crypto.randomUUID().replace(/-/g, ''), [])
  const document = useMemo(() => draftDocument(channel, nonce), [channel, nonce])
  const loaded = useRef(false)
  const latest = useRef(html)
  latest.current = html
  const send = useCallback(() => {
    if (loaded.current) frame.current?.contentWindow?.postMessage({ type: 'gideon-draft', channel, html: latest.current }, '*')
  }, [channel])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'gideon-draft-ready' || event.data?.channel !== channel) return
      loaded.current = true
      send()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [channel, send])
  useEffect(send, [html, send])
  return <iframe ref={frame} title={`${title} (being drawn)`} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" className="illustration-frame" />
}

export function Illustration({ block, front, drafting = false, onAsk }: { block: IllustrationBlock; front: boolean; drafting?: boolean; onAsk?: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, retry] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'repairing' | 'error'>('loading')
  const [revision, setRevision] = useState<{ source: string; block: IllustrationBlock } | null>(null)
  const current = revision?.source === block.html ? revision.block : block
  const repairTried = useRef<string | null>(null)
  const id = useId()
  const channel = `${id}:${attempt}`
  const document = useMemo(() => drafting ? '' : illustrationDocument(current.html, current.title, channel), [drafting, current.html, current.title, channel])
  useEffect(() => {
    if (!front || drafting) return
    setStatus('loading')
    const controller = new AbortController()
    let failed = false
    const fail = (detail: string) => {
      if (failed) return
      failed = true
      clearTimeout(timer)
      if (repairTried.current === block.html) { setStatus('error'); return }
      repairTried.current = block.html
      setStatus('repairing')
      fetch(backendUrl('/api/illustration-repair'), { method: 'POST', headers: backendHeaders('application/json'), credentials: 'same-origin', signal: controller.signal, body: JSON.stringify({ title: current.title, summary: current.summary, html: current.html, error: detail.slice(0, 300) || 'The drawing did not render.' }) }).then(async response => {
        if (!response.ok) throw new Error('Repair unavailable')
        const data: unknown = await response.json()
        const repaired = readBlocks([(data as { block?: unknown } | null)?.block], 0)[0]
        if (repaired?.type !== 'illustration') throw new Error('Invalid repaired drawing')
        if (!controller.signal.aborted) {
          setRevision({ source: block.html, block: repaired })
          retry(value => value + 1)
          setStatus('loading')
        }
      }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    }
    const timer = setTimeout(() => fail('The drawing did not finish loading.'), 10_000)
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'gideon-illustration' || event.data?.channel !== channel) return
      if (event.data.state === 'error') fail(typeof event.data.detail === 'string' ? event.data.detail : '')
      else if (event.data.state === 'ready' && !failed) { clearTimeout(timer); setStatus('ready') }
    }
    window.addEventListener('message', receive)
    return () => { clearTimeout(timer); controller.abort(); window.removeEventListener('message', receive) }
  }, [front, drafting, channel, block.html, current.html, current.title, current.summary])
  const download = () => {
    const url = URL.createObjectURL(new Blob([document], { type: 'text/html;charset=utf-8' }))
    const link = window.document.createElement('a')
    link.href = url; link.download = `${block.title.replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) || 'drawing'}.html`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const watching = drafting && front
  return <section className="illustration-work" aria-label={block.title}>
    <header className="illustration-tools"><span>{drafting ? <><i className="illustration-pulse" aria-hidden="true" />Drawing it now</> : 'Interactive drawing · first draft'}</span><button type="button" onClick={download} disabled={!front || drafting || status !== 'ready'}>Save HTML</button></header>
    {watching ? <DraftView html={current.html} title={current.title} /> : null}
    {!drafting && front && (status === 'loading' || status === 'ready') ? <iframe key={channel} ref={frame} title={current.title} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" className="illustration-frame" /> : null}
    {!drafting && status === 'loading' && front ? <p className="illustration-status" role="status">Opening the drawing…</p> : null}
    {!drafting && status === 'repairing' && front ? <p className="illustration-status" role="status">Refining the drawing…</p> : null}
    {!drafting && status === 'error' ? <div className="illustration-error" role="alert"><p>This drawing could not run. Ask Gideon to simplify it or try opening it again.</p><button type="button" onClick={() => { setStatus('loading'); retry(value => value + 1) }} disabled={!front}>Open again</button>{onAsk ? <button type="button" disabled={!front} onClick={() => onAsk(`Draw a fresh, simpler version of ${block.title}. ${block.summary} The previous drawing failed to run.`)}>Generate again</button> : null}</div> : null}
    <p className="illustration-caption" role={drafting ? 'status' : undefined}>{drafting ? 'You are watching it being drawn. The controls come on once it is finished.' : current.summary}</p>
  </section>
}
