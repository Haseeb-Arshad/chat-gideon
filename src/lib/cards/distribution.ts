/** Equal-width bins from observations. Every observation is counted exactly once. */
export function histogram(values: number[]) {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const count = Math.min(8, Math.ceil(Math.sqrt(values.length)))
  // Repeated floating-point boundaries collapse rather than creating empty-width bins.
  const edges = [...new Set(Array.from({ length: count + 1 }, (_, index) => low + (high - low) * index / count))]
  if (edges.length === 1) return { labels: [String(low)], counts: [values.length], edges }
  const counts = new Array<number>(edges.length - 1).fill(0)
  for (const value of values) {
    const next = edges.findIndex((edge) => edge > value)
    counts[next < 0 ? counts.length - 1 : Math.max(0, next - 1)]++
  }
  const labels = counts.map((_, index) => `${edges[index]}–${edges[index + 1]}`)
  return { labels, counts, edges }
}
