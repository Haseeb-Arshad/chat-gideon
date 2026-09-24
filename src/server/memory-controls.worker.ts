/**
 * Cloudflare build stand-in for the Node memory controls.
 *
 * The inspector reads the Node PostgreSQL authority, which the Worker does
 * not bundle. `vite.config.ts` resolves `memory-controls.ts` to this module in
 * Cloudflare mode, so the route answers plainly that controls are not
 * available on this host instead of pretending there is nothing remembered.
 */
export async function handleMemoryControls(_request: Request): Promise<Response> {
  return Response.json(
    { ok: false, error: { code: 'memory_controls_unavailable', message: 'Memory controls are not available on this host yet.', retryable: false } },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}
