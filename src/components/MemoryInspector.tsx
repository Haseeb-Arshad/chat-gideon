import { ArrowLeft, Check, ChevronDown, CircleAlert, Download, Loader2, Pencil, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ensureAccount } from '../lib/backend'
import {
  RETENTION_CHOICES,
  SETTING_EFFECTS,
  type InspectorDetail,
  type InspectorFilter,
  type InspectorItem,
  type InspectorOverview,
  type InspectorPage,
  type MemorySettingsView,
} from '../lib/memory/controls'

/**
 * The memory inspector: what GIDEON remembers, why, where it applies, and
 * the controls to change or remove it.
 *
 * Every state shown here comes back from the server after it committed. An
 * edit shows the accepted wording, not what was typed; a forget shows the
 * logical block and the physical cleanup as separate facts; a stale tab gets
 * the conflict, never a silent overwrite.
 */

type ApiError = { code: string; message: string; retryable: boolean; details?: { currentRevision?: number } }
type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError; status: number }

async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...init })
    const body = await response.json().catch(() => null) as ({ ok?: boolean; error?: ApiError } & Record<string, unknown>) | null
    if (response.ok && body?.ok) return { ok: true, value: body as T }
    return { ok: false, status: response.status, error: body?.error ?? { code: 'unavailable', message: 'Memory is unavailable right now.', retryable: true } }
  } catch {
    return { ok: false, status: 0, error: { code: 'offline', message: 'Could not reach GIDEON. Check the connection and try again.', retryable: true } }
  }
}

function post<T>(body: Record<string, unknown>): Promise<ApiResult<T>> {
  return api<T>('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

function requestId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

const BASIS_LABEL: Record<InspectorItem['basis'], string> = {
  explicit: 'You said this',
  corrected: 'You corrected this',
  learned: 'Learned from what you said',
  inferred: 'Inferred, not said outright',
  imported: 'Imported from a file',
  tool: 'From a verified tool result',
  other: 'Other source',
}

const KIND_LABEL: Record<string, string> = {
  preference: 'Preference', constraint: 'Constraint', fact: 'Fact', decision: 'Decision', episode_checkpoint: 'Topic',
}

const REASON_LABEL: Record<string, string> = {
  inferred_from_instruction: 'Asked once for a task; kept as a possible preference until it recurs.',
  change_requires_review: 'Sounds like something changed; waiting for you to confirm.',
  classifier_abstained: 'Not certain this is a lasting fact about you.',
  self_statement: 'Taken from something you said.',
  independent_support: 'Seen in several separate conversations.',
}

const FILTERS: { id: InspectorFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'facts', label: 'Facts' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'proposed', label: 'Proposed' },
  { id: 'topics', label: 'Topics' },
]

function when(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

type Announce = (message: string) => void
type Removal = { deletionId: string; text: string }
type Changed = (removed?: Removal) => void

/** A valid-time bound as the user's local calendar date. */
function day(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
}

// ---------------------------------------------------------------------------
// Item card with source inspection, edit and forget
// ---------------------------------------------------------------------------

type ItemState =
  | { mode: 'view' }
  | { mode: 'edit' }
  | { mode: 'confirm-forget' }
  | { mode: 'forgotten'; deletionId: string; physical: string }

function ItemCard({ item: initial, announce, onChanged }: { item: InspectorItem; announce: Announce; onChanged: Changed }) {
  const [item, setItem] = useState(initial)
  const [state, setState] = useState<ItemState>({ mode: 'view' })
  const [detail, setDetail] = useState<InspectorDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState(initial.text)
  const [change, setChange] = useState<'mistake' | 'changed'>('mistake')
  const [since, setSince] = useState('')
  const [contextual, setContextual] = useState(false)
  const [context, setContext] = useState('')
  const pendingRequest = useRef<string | null>(null)
  const formId = useId()

  useEffect(() => setItem(initial), [initial])

  const loadDetail = useCallback(async () => {
    const result = await api<{ detail: InspectorDetail }>(`/api/memory?view=item&id=${encodeURIComponent(item.assertionId)}`)
    if (result.ok) setDetail(result.value.detail)
    else setError(result.error.message)
  }, [item.assertionId])

  const toggleDetail = () => {
    setDetailOpen((open) => !open)
    if (!detail) void loadDetail()
  }

  const refresh = async (message: string) => {
    const result = await api<{ detail: InspectorDetail }>(`/api/memory?view=item&id=${encodeURIComponent(item.assertionId)}`)
    if (result.ok) {
      setItem(result.value.detail.item)
      setDetail(result.value.detail)
      setDraft(result.value.detail.item.text)
    }
    setError(message)
  }

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    // One id per attempt: a retry after a lost response cannot apply twice.
    pendingRequest.current ??= requestId()
    const result = await post<{ edit: { item: InspectorItem; general: InspectorItem | null; receiptState: string; duplicate: boolean } }>({
      op: 'edit',
      assertionId: item.assertionId,
      expectedRevision: item.revision,
      text: draft,
      change,
      since: change === 'changed' && since ? new Date(`${since}T00:00:00`).toISOString() : null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      context: contextual ? context : null,
      requestId: pendingRequest.current,
    })
    setBusy(false)
    if (result.ok) {
      pendingRequest.current = null
      const edit = result.value.edit
      if (edit.general) {
        setItem(edit.general)
        announce(`Saved a version for “${context}”. The general memory is unchanged.`)
        onChanged()
      } else {
        setItem(edit.item)
        announce(edit.duplicate ? 'That wording was already remembered.' : `Saved. Memory now reads: ${edit.item.text}`)
      }
      setDetail(null)
      setState({ mode: 'view' })
      return
    }
    if (result.error.code === 'conflict') {
      pendingRequest.current = null
      await refresh('This memory changed in another tab or conversation. Here is the current wording; nothing was saved.')
      setState({ mode: 'view' })
      return
    }
    if (!result.error.retryable) pendingRequest.current = null
    setError(`${result.error.message}${result.error.retryable ? ' Nothing was confirmed saved; you can try again.' : ''}`)
  }

  const forget = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    pendingRequest.current ??= requestId()
    const result = await post<{ forget: { deletionId: string; physical: { status: string } } }>({
      op: 'forget', assertionId: item.assertionId, expectedRevision: item.revision, requestId: pendingRequest.current,
    })
    setBusy(false)
    pendingRequest.current = null
    if (result.ok) {
      setState({ mode: 'forgotten', deletionId: result.value.forget.deletionId, physical: result.value.forget.physical.status })
      announce('Forgotten. It is no longer used or shown. Cleanup of stored copies is shown under Removals.')
      onChanged({ deletionId: result.value.forget.deletionId, text: item.text })
      return
    }
    if (result.error.code === 'conflict') {
      await refresh('This memory changed since you opened it. Review the current wording before forgetting it.')
      setState({ mode: 'view' })
      return
    }
    if (result.error.code === 'not_found' || result.error.code === 'suppressed') {
      setState({ mode: 'forgotten', deletionId: '', physical: 'complete' })
      announce('That memory was already forgotten.')
      return
    }
    setError(`${result.error.message} It was not reported as forgotten.`)
    setState({ mode: 'view' })
  }

  // Physical cleanup is a separate, later fact; poll it briefly.
  useEffect(() => {
    if (state.mode !== 'forgotten' || !state.deletionId || state.physical === 'complete') return
    let attempts = 0
    const timer = window.setInterval(async () => {
      attempts += 1
      const result = await api<{ status: { physical: { status: string } } }>(`/api/memory?view=deletion&id=${encodeURIComponent(state.deletionId)}`)
      if (result.ok) setState((current) => current.mode === 'forgotten' ? { ...current, physical: result.value.status.physical.status } : current)
      if (attempts >= 15 || (result.ok && result.value.status.physical.status !== 'pending')) window.clearInterval(timer)
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [state])

  if (state.mode === 'forgotten') {
    return (
      <li className="memory-item" data-forgotten="true">
        <p className="memory-item-text">Forgotten</p>
        <p className="memory-meta">
          No longer used in conversations, recall or exports.{' '}
          {state.deletionId ? (state.physical === 'complete' ? 'Stored copies are cleaned up.' : state.physical === 'failed' ? 'Cleanup of stored copies failed and will be retried by an operator.' : 'Cleanup of stored copies is in progress.') : null}
          {' '}Copies you downloaded earlier are not affected.
        </p>
      </li>
    )
  }

  const sourceCount = item.sources.count
  return (
    <li className="memory-item" data-status={item.status} data-freshness={item.freshness}>
      <div className="memory-item-head">
        <p className="memory-item-text">{item.text}</p>
        {item.kind !== 'episode_checkpoint' && item.status !== 'candidate' ? (
          <div className="memory-item-actions">
            <button type="button" onClick={() => { setState(state.mode === 'edit' ? { mode: 'view' } : { mode: 'edit' }); setDraft(item.text) }} aria-expanded={state.mode === 'edit'} aria-controls={formId} aria-label={`Edit: ${item.text}`}>
              <Pencil size={13} /> <span>Edit</span>
            </button>
            <button type="button" onClick={() => setState({ mode: 'confirm-forget' })} aria-label={`Forget: ${item.text}`}>
              <Trash2 size={13} /> <span>Forget</span>
            </button>
          </div>
        ) : item.status === 'candidate' ? (
          <div className="memory-item-actions">
            <button type="button" onClick={() => setState({ mode: 'confirm-forget' })} aria-label={`Dismiss: ${item.text}`}>
              <Trash2 size={13} /> <span>Dismiss</span>
            </button>
          </div>
        ) : null}
      </div>
      <ul className="memory-badges" aria-label="About this memory">
        <li>{KIND_LABEL[item.kind] ?? item.kind}</li>
        <li>{BASIS_LABEL[item.basis]}</li>
        <li>Applies {item.scope.kind === 'general' ? 'everywhere' : item.scope.label}</li>
        {item.status === 'candidate' ? <li data-tone="proposed">Proposed — not used yet</li> : null}
        {item.conflict.disputed || item.conflict.contradicting ? <li data-tone="warn">Conflicting evidence</li> : null}
        {item.freshness === 'expired' ? <li data-tone="muted">Expired</li> : null}
        {item.revisions > 1 ? <li>{item.revisions} versions</li> : null}
      </ul>
      {item.proposedReason && REASON_LABEL[item.proposedReason] ? <p className="memory-meta">{REASON_LABEL[item.proposedReason]}</p> : null}
      <p className="memory-meta">
        Remembered {when(item.interpretedAt)}
        {item.validTime.from ? ` · true from ${day(item.validTime.from)}` : ''}
        {item.validTime.until ? ` · until ${day(item.validTime.until)}` : ''}
      </p>

      {state.mode === 'confirm-forget' ? (
        <div className="memory-confirm" role="group" aria-label="Confirm forgetting">
          <p>{item.status === 'candidate' ? 'Dismiss this proposed memory?' : 'Forget this memory?'} It stops being used right away, together with the words it came from. This cannot be undone here.</p>
          <div>
            <button type="button" className="memory-danger" onClick={forget} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} {item.status === 'candidate' ? 'Dismiss' : 'Forget'}</button>
            <button type="button" onClick={() => setState({ mode: 'view' })} disabled={busy}>Keep it</button>
          </div>
        </div>
      ) : null}

      {state.mode === 'edit' ? (
        <form id={formId} className="memory-edit" onSubmit={submitEdit}>
          <label htmlFor={`${formId}-text`}>
            <span>New wording</span>
          </label>
          <textarea id={`${formId}-text`} value={draft} onChange={(event) => { setDraft(event.target.value); pendingRequest.current = null }} maxLength={1000} rows={2} required />
          <fieldset>
            <legend>What happened?</legend>
            <div className="memory-inline"><input id={`${formId}-mistake`} type="radio" name={`${formId}-change`} checked={change === 'mistake'} onChange={() => setChange('mistake')} /><label htmlFor={`${formId}-mistake`}>It was wrong — it was never true</label></div>
            <div className="memory-inline"><input id={`${formId}-changed`} type="radio" name={`${formId}-change`} checked={change === 'changed'} onChange={() => setChange('changed')} /><label htmlFor={`${formId}-changed`}>It changed — it was true before</label></div>
            {change === 'changed' ? (
              <div className="memory-inline">
                <label htmlFor={`${formId}-since`}>Since</label>
                <input id={`${formId}-since`} type="date" value={since} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setSince(event.target.value)} />
              </div>
            ) : null}
          </fieldset>
          <div className="memory-inline">
            <input id={`${formId}-contextual`} type="checkbox" checked={contextual} onChange={(event) => setContextual(event.target.checked)} />
            <label htmlFor={`${formId}-contextual`}>Only when working on a specific topic (keep the general memory)</label>
          </div>
          {contextual ? (
            <>
              <label htmlFor={`${formId}-topic`}><span>Topic</span></label>
              <input id={`${formId}-topic`} type="text" value={context} onChange={(event) => setContext(event.target.value)} maxLength={120} required placeholder="for example: investor deck" />
            </>
          ) : null}
          <div className="memory-edit-actions">
            <button type="submit" disabled={busy || !draft.trim()}>{busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Save</button>
            <button type="button" onClick={() => setState({ mode: 'view' })} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}

      {error ? <p className="memory-error" role="alert"><CircleAlert size={13} /> {error}</p> : null}

      <button type="button" className="memory-sources-toggle" onClick={toggleDetail} aria-expanded={detailOpen}>
        <ChevronDown size={13} data-open={detailOpen} /> {sourceCount ? `Why GIDEON remembers this (${sourceCount} source${sourceCount === 1 ? '' : 's'})` : 'Why GIDEON remembers this'}
      </button>
      {detailOpen ? (
        <div className="memory-detail">
          {!detail ? <p className="memory-meta"><Loader2 size={12} className="spin" /> Loading…</p> : (
            <>
              {detail.sources.length ? (
                <ul className="memory-sources">
                  {detail.sources.map((source) => (
                    <li key={source.eventId}>
                      {source.quote ? <q>{source.quote}</q> : <span className="memory-meta">{source.kind.replaceAll('_', ' ')} (text not shown)</span>}
                      <small>{when(source.receivedAt)}{source.relation === 'contradicts' ? ' · contradicts' : ''}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="memory-meta">
                  {item.sources.gap === 'no_citation_imported' ? 'Imported from a file, so there is no conversation to cite.' : 'No source is available: it was removed by retention or deletion, or never recorded.'}
                </p>
              )}
              {detail.history.length > 1 ? (
                <>
                  <p className="memory-subhead">History</p>
                  <ol className="memory-history">
                    {detail.history.map((version) => (
                      <li key={version.revision} data-current={version.revision === item.revision}>
                        <span>{version.text}</span>
                        <small>
                          {version.relation === 'correction' ? 'corrected — the earlier wording was wrong' : version.relation === 'transition' ? `changed${version.validTime.from ? ` from ${day(version.validTime.from)}` : ''} — the earlier wording was true before` : version.revision === 1 ? 'first remembered' : version.relation}
                          {' · '}{when(version.interpretedAt)}
                        </small>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}

function ItemList({ items, announce, onChanged, empty }: { items: readonly InspectorItem[]; announce: Announce; onChanged: Changed; empty: string }) {
  if (!items.length) return <p className="memory-empty">{empty}</p>
  return (
    <ul className="memory-list">
      {items.map((item) => <ItemCard key={`${item.assertionId}#${item.revision}`} item={item} announce={announce} onChanged={onChanged} />)}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsPanel({ settings, onSettings, announce }: { settings: MemorySettingsView; onSettings: (settings: MemorySettingsView) => void; announce: Announce }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (change: Record<string, unknown>, done: string) => {
    setBusy(true)
    setError(null)
    const result = await post<{ settings: MemorySettingsView }>({ op: 'settings', expectedRevision: settings.revision, ...change })
    setBusy(false)
    if (result.ok) {
      onSettings(result.value.settings)
      announce(done)
      return
    }
    if (result.error.code === 'conflict') {
      const current = await api<{ settings: MemorySettingsView }>('/api/memory?view=settings')
      if (current.ok) onSettings(current.value.settings)
      setError('These settings changed somewhere else. The current values are shown; nothing was changed.')
      return
    }
    setError(`${result.error.message} Nothing was changed.`)
  }

  return (
    <section className="memory-card memory-settings" aria-labelledby="memory-settings-title">
      <h2 id="memory-settings-title">Controls</h2>
      <div className="memory-setting">
        <label className="memory-switch" htmlFor="memory-learning">
          <input id="memory-learning" type="checkbox" role="switch" aria-labelledby="memory-learning-label" aria-describedby="memory-learning-effect" checked={settings.learningEnabled} disabled={busy}
            onChange={(event) => save({ learningEnabled: event.target.checked }, event.target.checked ? 'Learning is on.' : 'Learning is off. Nothing was deleted.')} />
          <span id="memory-learning-label">Learn from conversations</span>
        </label>
        <p id="memory-learning-effect">{SETTING_EFFECTS.learning}</p>
      </div>
      <div className="memory-setting">
        <label className="memory-switch" htmlFor="memory-temporary">
          <input id="memory-temporary" type="checkbox" role="switch" aria-labelledby="memory-temporary-label" aria-describedby="memory-temporary-effect" checked={settings.temporaryActive} disabled={busy}
            onChange={(event) => save({ temporary: event.target.checked }, event.target.checked ? 'Temporary conversation is on for 24 hours.' : 'Temporary conversation is off.')} />
          <span id="memory-temporary-label">Temporary conversation</span>
        </label>
        <p id="memory-temporary-effect">{SETTING_EFFECTS.temporary}{settings.temporaryActive && settings.temporaryUntil ? ` On until ${when(settings.temporaryUntil)}.` : ''}</p>
      </div>
      <div className="memory-setting">
        <label className="memory-select" htmlFor="memory-retention">
          <span id="memory-retention-label">Keep conversation turns that never became a memory</span>
          <select id="memory-retention" aria-labelledby="memory-retention-label" aria-describedby="memory-retention-effect" value={settings.evidenceRetentionDays ?? ''} disabled={busy}
            onChange={(event) => {
              const days = event.target.value ? Number(event.target.value) : null
              void save({ evidenceRetentionDays: days }, days ? `Unused conversation turns will be deleted after ${days} days.` : 'Unused conversation turns are kept until you delete them.')
            }}>
            {RETENTION_CHOICES.map((choice) => <option key={choice ?? 'forever'} value={choice ?? ''}>{choice ? `${choice} days` : 'Until I delete them'}</option>)}
          </select>
        </label>
        <p id="memory-retention-effect">{SETTING_EFFECTS.retention}</p>
      </div>
      {error ? <p className="memory-error" role="alert"><CircleAlert size={13} /> {error}</p> : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

function TransferPanel({ announce, onImported }: { announce: Announce; onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const importFile = async (file: File) => {
    setBusy(true)
    setError(null)
    setResult(null)
    if (file.size > 512 * 1024) {
      setBusy(false)
      setError('That file is larger than 512 KB and cannot be imported.')
      return
    }
    let document: unknown
    try {
      document = JSON.parse(await file.text())
    } catch {
      setBusy(false)
      setError('That file is not a GIDEON memory export (it is not valid JSON).')
      return
    }
    const response = await post<{ imported: { counts: Record<string, number> } }>({ op: 'import', document })
    setBusy(false)
    if (input.current) input.current.value = ''
    if (!response.ok) {
      setError(response.error.message)
      return
    }
    const counts = response.value.imported.counts
    const parts = [
      counts.imported ? `${counts.imported} added` : null,
      counts.duplicate || counts.unchanged ? `${(counts.duplicate ?? 0) + (counts.unchanged ?? 0)} already here` : null,
      counts.suppressed ? `${counts.suppressed} skipped because you forgot them` : null,
      counts.stale ? `${counts.stale} skipped because they changed since the export` : null,
      counts.not_accepted ? `${counts.not_accepted} proposed item(s) not imported` : null,
      counts.invalid || counts.failed ? `${(counts.invalid ?? 0) + (counts.failed ?? 0)} could not be read` : null,
    ].filter(Boolean)
    const summary = `Import finished: ${parts.join(', ') || 'nothing to import'}.`
    setResult(summary)
    announce(summary)
    onImported()
  }

  return (
    <section className="memory-card" aria-labelledby="memory-transfer-title">
      <h2 id="memory-transfer-title">Export and import</h2>
      <div className="memory-transfer">
        <a className="memory-button" href="/api/memory?view=export" download><Download size={14} /> Download (JSON)</a>
        <a className="memory-button" href="/api/memory?view=export&format=md" download><Download size={14} /> Readable copy (Markdown)</a>
        <label className="memory-button" data-busy={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Import a JSON export
          <input ref={input} type="file" accept="application/json,.json" className="sr-only" disabled={busy} aria-label="Import a JSON export"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file) }} />
        </label>
      </div>
      <p className="memory-meta">A downloaded file is a copy outside GIDEON. Forgetting something later removes it here, not from files you saved or shared. Importing never brings back something you forgot, and it adds items as imported rather than as things you said.</p>
      {result ? <p className="memory-ok" role="status"><Check size={13} /> {result}</p> : null}
      {error ? <p className="memory-error" role="alert"><CircleAlert size={13} /> {error}</p> : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Removals: forgetting is immediate; physical cleanup is its own, later fact
// ---------------------------------------------------------------------------

function RemovalStatus({ removal }: { removal: Removal }) {
  const [physical, setPhysical] = useState('pending')
  useEffect(() => {
    let attempts = 0
    let stopped = false
    const check = async () => {
      attempts += 1
      const result = await api<{ status: { physical: { status: string } } }>(`/api/memory?view=deletion&id=${encodeURIComponent(removal.deletionId)}`)
      if (stopped) return
      if (result.ok) setPhysical(result.value.status.physical.status)
      if (attempts < 20 && (!result.ok || result.value.status.physical.status === 'pending')) timer = window.setTimeout(check, 3_000)
    }
    let timer = window.setTimeout(check, 1_000)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [removal.deletionId])
  return (
    <li data-physical={physical}>
      <span>{removal.text}</span>
      <small>
        No longer used · {physical === 'complete' ? 'stored copies cleaned up' : physical === 'failed' ? 'cleanup failed; it will be retried' : 'cleaning up stored copies…'}
      </small>
    </li>
  )
}

function RemovalsPanel({ removals }: { removals: readonly Removal[] }) {
  return (
    <section className="memory-card" aria-labelledby="memory-removals-title">
      <h2 id="memory-removals-title">Removals</h2>
      <ul className="memory-recent" aria-live="polite">
        {removals.map((removal) => <RemovalStatus key={removal.deletionId} removal={removal} />)}
      </ul>
      <p className="memory-meta">Copies you downloaded earlier are not affected.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type PageState =
  | { phase: 'loading' }
  | { phase: 'unavailable'; message: string }
  | { phase: 'failed'; message: string }
  | { phase: 'off' }
  | { phase: 'ready'; overview: InspectorOverview }

function Browser({ announce, version, onChanged }: { announce: Announce; version: number; onChanged: Changed }) {
  const [filter, setFilter] = useState<InspectorFilter>('all')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [items, setItems] = useState<InspectorItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (next: string | null) => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ view: 'items', filter, limit: '20' })
    if (submitted) params.set('q', submitted)
    if (next) params.set('cursor', next)
    const result = await api<{ page: InspectorPage }>(`/api/memory?${params}`)
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setItems((current) => next ? [...current, ...result.value.page.items] : [...result.value.page.items])
    setCursor(result.value.page.nextCursor)
  }, [filter, submitted])

  useEffect(() => { void load(null) }, [load, version])

  return (
    <section className="memory-card" aria-labelledby="memory-browse-title">
      <h2 id="memory-browse-title">Everything remembered</h2>
      <div className="memory-browse-bar">
        <div className="memory-tabs" role="tablist" aria-label="Filter memories">
          {FILTERS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={filter === entry.id} onClick={() => setFilter(entry.id)}>{entry.label}</button>
          ))}
        </div>
        <form role="search" onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()) }}>
          <label className="sr-only" htmlFor="memory-search">Search memories</label>
          <input id="memory-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" maxLength={120} />
        </form>
      </div>
      {error ? (
        <p className="memory-error" role="alert"><CircleAlert size={13} /> {error} <button type="button" onClick={() => load(null)}><RotateCcw size={12} /> Retry</button></p>
      ) : null}
      {!error && !loading && !items.length ? <p className="memory-empty">{submitted ? 'Nothing matches that search.' : 'Nothing here yet.'}</p> : null}
      {items.length ? <ItemList items={items} announce={announce} onChanged={onChanged} empty="" /> : null}
      {loading ? <p className="memory-meta" aria-live="polite"><Loader2 size={12} className="spin" /> Loading…</p> : null}
      {cursor && !loading ? <button type="button" className="memory-button memory-more" onClick={() => load(cursor)}>Show more</button> : null}
    </section>
  )
}

export function MemoryInspector() {
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [message, setMessage] = useState('')
  const [version, setVersion] = useState(0)
  const [enabling, setEnabling] = useState(false)
  const [removals, setRemovals] = useState<Removal[]>([])

  const announce = useCallback((text: string) => setMessage(text), [])

  const load = useCallback(async () => {
    await ensureAccount(3_000).catch(() => undefined)
    const status = await api<{ enabled: boolean }>('/api/memory?view=status')
    if (!status.ok) {
      if (status.status === 404) setState({ phase: 'unavailable', message: status.error.message })
      else setState({ phase: 'failed', message: status.error.message })
      return
    }
    if (!status.value.enabled) {
      setState({ phase: 'off' })
      return
    }
    const overview = await api<{ overview: InspectorOverview }>('/api/memory?view=overview')
    if (!overview.ok) {
      setState({ phase: 'failed', message: overview.error.message })
      return
    }
    setState({ phase: 'ready', overview: overview.value.overview })
  }, [])

  useEffect(() => { void load() }, [load])

  const changed = useCallback((removed?: Removal) => {
    if (removed) setRemovals((current) => [removed, ...current.filter((entry) => entry.deletionId !== removed.deletionId)].slice(0, 10))
    setVersion((value) => value + 1)
    void api<{ overview: InspectorOverview }>('/api/memory?view=overview').then((result) => {
      if (result.ok) setState({ phase: 'ready', overview: result.value.overview })
    })
  }, [])

  const enable = async () => {
    setEnabling(true)
    const result = await post<{ settings: MemorySettingsView }>({ op: 'enable' })
    setEnabling(false)
    if (!result.ok) {
      setState({ phase: 'failed', message: result.error.message })
      return
    }
    announce('Memory is on.')
    await load()
  }

  const overview = state.phase === 'ready' ? state.overview : null
  const counts = useMemo(() => overview?.counts, [overview])

  return (
    <main className="memory-page">
      <header className="memory-header">
        <a className="memory-back" href="/"><ArrowLeft size={15} /> GIDEON</a>
        <h1>Memory</h1>
        <p>What GIDEON remembers about you, why, and where it is used. Changes here take effect in your next message.</p>
      </header>
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
      {message ? <p className="memory-toast" aria-hidden="true"><Check size={13} /> {message}</p> : null}

      {state.phase === 'loading' ? <p className="memory-meta memory-state"><Loader2 size={14} className="spin" /> Loading your memory…</p> : null}
      {state.phase === 'unavailable' ? <p className="memory-state">Memory controls are not available on this server. {state.message}</p> : null}
      {state.phase === 'failed' ? (
        <div className="memory-state" role="alert">
          <p><CircleAlert size={14} /> {state.message}</p>
          <p className="memory-meta">This does not mean anything was forgotten.</p>
          <button type="button" className="memory-button" onClick={() => { setState({ phase: 'loading' }); void load() }}><RotateCcw size={13} /> Try again</button>
        </div>
      ) : null}
      {state.phase === 'off' ? (
        <section className="memory-card memory-state">
          <h2>Memory is off</h2>
          <p>GIDEON does not keep anything about you between conversations yet. Turning memory on lets it remember what you ask it to, learn carefully from what you say, and show all of it here, where you can correct or remove anything.</p>
          <button type="button" className="memory-button" onClick={enable} disabled={enabling}>{enabling ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Turn on memory</button>
        </section>
      ) : null}

      {overview ? (
        <>
          {overview.settings.temporaryActive ? (
            <p className="memory-banner" role="note">A temporary conversation is on until {when(overview.settings.temporaryUntil)}: nothing is saved or used.</p>
          ) : null}
          <div className="memory-grid">
            <div className="memory-column">
              <section className="memory-card" aria-labelledby="memory-overview-title">
                <h2 id="memory-overview-title">At a glance</h2>
                <ul className="memory-counts">
                  <li><b>{counts?.accepted ?? 0}</b> remembered</li>
                  <li><b>{counts?.proposed ?? 0}</b> proposed</li>
                  <li><b>{counts?.disputed ?? 0}</b> conflicting</li>
                  <li><b>{counts?.topics ?? 0}</b> topics</li>
                </ul>
                <h3>Preferences</h3>
                <ItemList items={overview.preferences} announce={announce} onChanged={changed} empty="No preferences yet." />
                <h3>About you</h3>
                <ItemList items={overview.facts} announce={announce} onChanged={changed} empty="No facts yet." />
                {overview.decisions.length ? <><h3>Decisions</h3><ItemList items={overview.decisions} announce={announce} onChanged={changed} empty="" /></> : null}
                {overview.topics.length ? <><h3>Ongoing topics</h3><ItemList items={overview.topics} announce={announce} onChanged={changed} empty="" /></> : null}
                {overview.proposed.length ? (
                  <>
                    <h3>Proposed</h3>
                    <p className="memory-meta">Possible memories GIDEON noticed but does not use until they are confirmed. Tell GIDEON “remember that…” to keep one.</p>
                    <ItemList items={overview.proposed} announce={announce} onChanged={changed} empty="" />
                  </>
                ) : null}
              </section>
              <Browser announce={announce} version={version} onChanged={changed} />
            </div>
            <div className="memory-column memory-side">
              <SettingsPanel settings={overview.settings} onSettings={(settings) => setState({ phase: 'ready', overview: { ...overview, settings } })} announce={announce} />
              {removals.length ? <RemovalsPanel removals={removals} /> : null}
              <TransferPanel announce={announce} onImported={() => changed()} />
              {overview.recentChanges.length ? (
                <section className="memory-card" aria-labelledby="memory-recent-title">
                  <h2 id="memory-recent-title">Recent changes</h2>
                  <ul className="memory-recent">
                    {overview.recentChanges.map((change, index) => (
                      <li key={`${change.at}-${index}`}>
                        <span>{change.text ?? 'A memory that was since forgotten'}</span>
                        <small>{change.kind.replaceAll('_', ' ')} · {when(change.at)}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </main>
  )
}
