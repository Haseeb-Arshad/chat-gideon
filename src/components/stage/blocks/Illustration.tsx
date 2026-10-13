import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { IllustrationBlock } from '../../../lib/cards/schema'
import { illustrationDocument } from '../../../lib/illustrations/document'
import { readBlocks } from '../../../lib/cards/read'
import './illustration.css'

export function Illustration({ block, front, onAsk }: { block: IllustrationBlock; front: boolean; onAsk?: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, retry] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'repairing' | 'error'>('loading')
  const [revision, setRevision] = useState<{ source: string; block: IllustrationBlock } | null>(null)
  const current = revision?.source === block.html ? revision.block : block
  const repairTried = useRef<string | null>(null)
  const id = useId()
  const channel = `${id}:${attempt}`
  const document = useMemo(() => illustrationDocument(current.html, current.title, channel), [current.html, current.title, channel])
  useEffect(() => {
    if (!front) return
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
      fetch('/api/illustration-repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: controller.signal, body: JSON.stringify({ title: current.title, summary: current.summary, html: current.html, error: detail.slice(0, 300) || 'The drawing did not render.' }) }).then(async response => {
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
  }, [front, channel, block.html, current.html, current.title, current.summary])
  const download = () => {
    const url = URL.createObjectURL(new Blob([document], { type: 'text/html;charset=utf-8' }))
    const link = window.document.createElement('a')
    link.href = url; link.download = `${block.title.replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) || 'drawing'}.html`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  return <section className="illustration-work" aria-label={block.title}>
    <header className="illustration-tools"><span>Interactive drawing · first draft</span><button type="button" onClick={download} disabled={!front || status !== 'ready'}>Save HTML</button></header>
    {front && (status === 'loading' || status === 'ready') ? <iframe key={channel} ref={frame} title={current.title} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" className="illustration-frame" /> : null}
    {status === 'loading' && front ? <p className="illustration-status" role="status">Opening the drawing…</p> : null}
    {status === 'repairing' && front ? <p className="illustration-status" role="status">Refining the drawing…</p> : null}
    {status === 'error' ? <div className="illustration-error" role="alert"><p>This drawing could not run. Ask Gideon to simplify it or try opening it again.</p><button type="button" onClick={() => { setStatus('loading'); retry(value => value + 1) }} disabled={!front}>Open again</button>{onAsk ? <button type="button" disabled={!front} onClick={() => onAsk(`Draw a fresh, simpler version of ${block.title}. ${block.summary} The previous drawing failed to run.`)}>Generate again</button> : null}</div> : null}
    <p className="illustration-caption">{current.summary}</p>
  </section>
}
