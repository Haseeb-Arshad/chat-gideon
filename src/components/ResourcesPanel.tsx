import { ArrowUpRight, Check, CircleAlert, X } from 'lucide-react'
import { useEffect } from 'react'
import { useGlass } from './LiquidGlass'

/**
 * Everything GIDEON did and read, gathered behind one button.
 *
 * An agent that searches, remembers and sets timers has to be auditable: the
 * user must be able to see what was done on their behalf without taking
 * GIDEON's word for it. That used to be a list under the conversation, which
 * grew with every search until it crowded out the conversation it described.
 * Now it waits in here, grouped by what was asked, until someone wants it.
 */

export interface ResourceLink {
  id: string
  url: string
  title: string
  host: string
}

export interface Resource {
  id: string
  /** What it was about: the question asked, or what was done. */
  title: string
  /** How it went, in a few words. */
  detail: string
  ok: boolean
  /** Still happening; replaced in place when the result arrives. */
  pending: boolean
  at: number
  links: ResourceLink[]
}

function ago(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

export function ResourcesPanel({
  resources,
  onClose,
}: {
  resources: Resource[]
  onClose: () => void
}) {
  // Caught on the way down, so Escape closes this before it reaches the cards.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const newest = [...resources].reverse()
  const sources = resources.reduce((total, resource) => total + resource.links.length, 0)

  const glass = useGlass({ blur: 18, saturate: 165 })

  return (
    <aside
      className="resources-panel"
      role="dialog"
      aria-label="Resources"
      ref={glass.ref}
      style={glass.style}
      data-refracting={glass.refracting ? 'true' : undefined}
    >
      <header className="resources-head">
        <h2>Resources</h2>
        <span>
          {sources} source{sources === 1 ? '' : 's'}
        </span>
        <button type="button" onClick={onClose} aria-label="Close resources">
          <X size={15} strokeWidth={2.2} />
        </button>
      </header>

      <ol className="resource-list">
        {newest.map((resource) => (
          <li
            className="resource"
            key={resource.id}
            data-ok={resource.ok}
            data-pending={resource.pending ? 'true' : undefined}
          >
            <div className="resource-head">
              {resource.ok ? (
                <Check size={13} strokeWidth={2.5} />
              ) : (
                <CircleAlert size={13} strokeWidth={2.2} />
              )}
              <div>
                <p className="resource-title">{resource.title}</p>
                <p className="resource-detail">
                  {resource.detail} · {ago(resource.at)}
                </p>
              </div>
            </div>
            {resource.links.length ? (
              <ul className="resource-links">
                {resource.links.map((link) => (
                  <li key={link.id}>
                    <a href={link.url} target="_blank" rel="noreferrer noopener">
                      <span>{link.title}</span>
                      <small>{link.host}</small>
                      <ArrowUpRight size={12} strokeWidth={2.2} />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </aside>
  )
}
