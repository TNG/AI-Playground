export function formatMib(mib: number): string {
  if (!Number.isFinite(mib)) return '—'
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`
  return `${Math.round(mib)} MB`
}

export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${Math.round(pct)}%`
}
