import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class Socket {
  static OPEN = 1
  static CLOSED = 3
  static instances: Socket[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  sent: Array<Record<string, unknown>> = []
  constructor(_url: string) { Socket.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; this.onopen?.() }
  close() { this.readyState = 3; this.onclose?.() }
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const handlers = () => ({ onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn() })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let links: Array<{ dispose: () => void }> = []
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  Socket.instances = []
  vi.stubGlobal('window', { location: { origin: 'https://gideon.test', href: 'https://gideon.test/' } })
  vi.stubGlobal('localStorage', { getItem: () => 'browser', setItem: vi.fn() })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('WebSocket', Socket)
  vi.stubEnv('VITE_GIDEON_BACKEND_URL', '')
  vi.stubEnv('VITE_GIDEON_BACKEND_WS_URL', '')
  // Every fetch in this file is mocked. Never contact a real account/provider.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))))
})
afterEach(() => {
  for (const link of links) link.dispose()
  links = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
async function link(options = {}) {
  const { RealtimeLink } = await import('./realtime-client')
  const result = new RealtimeLink(options)
  links.push(result)
  return result
}

describe('account bootstrap', () => {
  it('does not forget a success arriving after the socket wait', async () => {
    const request = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(request.promise)
    const { ensureAccount, onAccountReady } = await import('./backend')
    const ready = vi.fn()
    const stop = onAccountReady(ready)
    const wait = ensureAccount()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await wait).toBe('pending')
    request.resolve(new Response(null, { status: 200 }))
    await tick()
    expect(ready).toHaveBeenCalledOnce()
    expect(await ensureAccount()).toBe('ready')
    stop()
  })

  it('allows 404 but rejects a bounded unresolved HTTP identity', async () => {
    const { awaitAccount } = await import('./backend')
    await expect(awaitAccount()).resolves.toBeUndefined()
    vi.resetModules()
    vi.mocked(fetch).mockReturnValue(new Promise(() => undefined))
    const backend = await import('./backend')
    const pending = expect(backend.awaitAccount()).rejects.toThrow('account is not ready')
    await vi.advanceTimersByTimeAsync(8_000)
    await pending
  })

  it.each([503, 'network'])('retries account errors (%s) without sending chat under a split identity', async (error) => {
    vi.mocked(fetch).mockImplementationOnce(() => error === 'network'
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: error as number })))
    const { awaitAccount } = await import('./backend')
    await expect(awaitAccount()).rejects.toThrow('account is not ready')
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
    await expect(awaitAccount()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('transport ownership and lifecycle', () => {
  it('keeps healthy HTTP alive when the socket probe rejects', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    vi.mocked(fetch).mockImplementation(async (url) => String(url) === '/api/account'
      ? new Response(null, { status: 404 })
      : new Response(new ReadableStream({ start(controller) { stream = controller } })))
    const client = await link()
    client.connect()
    const events = handlers()
    client.startTurn('http', [{ role: 'user', content: 'hello' }], events)
    await tick()
    const socket = Socket.instances[0]
    socket.onerror?.()
    socket.close()
    stream.enqueue(new TextEncoder().encode('{"t":"done","id":"http","text":"healthy"}\n'))
    stream.close()
    await tick()
    expect(events.onError).not.toHaveBeenCalled()
    expect(events.onDone).toHaveBeenCalledWith('healthy')
  })

  it('waits for account before sending HTTP, and cancels bootstrap wait on disposal', async () => {
    const account = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(account.promise)
    const client = await link()
    const events = handlers()
    client.startTurn('waiting', [], events)
    await tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    client.dispose()
    account.resolve(new Response(null, { status: 200 }))
    await tick()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(events.onDone).not.toHaveBeenCalled()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('cancels an HTTP voice account wait on disposal without fetching voice', async () => {
    const account = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(account.promise)
    const client = await link()
    const spoken = expect(client.speak('voice', 0, 'hello', new AbortController().signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    client.dispose()
    await spoken
    account.resolve(new Response(null, { status: 200 }))
    await tick()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rebinds after late identity only once the existing socket turn drains', async () => {
    const account = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(account.promise)
    const client = await link()
    client.connect()
    await vi.advanceTimersByTimeAsync(2_000)
    const socket = Socket.instances[0]
    socket.open()
    const events = handlers()
    client.startTurn('old-owner', [], events)
    account.resolve(new Response(null, { status: 200 }))
    await tick()
    expect(Socket.instances).toHaveLength(1)
    expect(events.onError).not.toHaveBeenCalled()
    socket.frame({ t: 'done', id: 'old-owner', text: 'finished' })
    expect(events.onDone).toHaveBeenCalledWith('finished')
    expect(Socket.instances).toHaveLength(2)
    Socket.instances[1].open()
    const next = handlers()
    client.startTurn('new-owner', [], next)
    // Old socket events cannot tear down the replacement.
    socket.close()
    expect(next.onError).not.toHaveBeenCalled()
    Socket.instances[1].close()
    expect(next.onError).toHaveBeenCalledOnce()
  })

  it('never opens or reconnects after disposal during bootstrap', async () => {
    const account = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(account.promise)
    const client = await link()
    client.connect()
    client.dispose()
    account.resolve(new Response(null, { status: 200 }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(Socket.instances).toHaveLength(0)
  })

  it('echoes the original turn and suppresses a tool result after cancellation', async () => {
    const first = deferred<{ ok: boolean; content: string }>()
    const tool = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, content: 'new' })
    const client = await link({ runClientTool: tool })
    client.connect()
    await tick()
    const socket = Socket.instances[0]
    socket.open()
    const turn = client.startTurn('old', [], handlers())
    socket.frame({ t: 'tool_request', id: 'old', call: 'where', name: 'get_location', args: {} })
    turn.cancel()
    client.startTurn('new', [], handlers())
    socket.frame({ t: 'tool_request', id: 'new', call: 'where', name: 'get_location', args: {} })
    first.resolve({ ok: true, content: 'stale' })
    await tick()
    expect(socket.sent.filter((frame) => frame.t === 'tool_reply')).toEqual([
      { t: 'tool_reply', id: 'new', call: 'where', ok: true, content: 'new' },
    ])
  })

  it('removes audio abort listeners when the binary reply settles', async () => {
    const client = await link()
    client.connect()
    await tick()
    const socket = Socket.instances[0]
    socket.open()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const audio = client.speak('turn', 0, 'hello', controller.signal)
    socket.frame({ t: 'audio', id: 'turn#0', mime: 'audio/mpeg', seq: 0, bytes: 1 })
    socket.onmessage?.({ data: new ArrayBuffer(1) })
    await audio
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(socket.sent.some((frame) => frame.t === 'cancel')).toBe(false)
  })
})
