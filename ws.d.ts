/**
 * `ws` ships without type declarations and is only reached through a dynamic
 * import in the dev-server plugin, where the shape is asserted locally.
 */
declare module 'ws'
