export function formatMib(mib: number): string {
  if (!Number.isFinite(mib)) return '—'
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`
  return `${Math.round(mib)} MB`
}

export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${Math.round(pct)}%`
}

export function formatEnergyWh(wattHours: number): string {
  if (!Number.isFinite(wattHours)) return '—'
  if (wattHours < 0.01) return `${(wattHours * 1000).toFixed(1)} mWh`
  if (wattHours < 1) return `${wattHours.toFixed(3)} Wh`
  return `${wattHours.toFixed(2)} Wh`
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2
  return `$${value.toFixed(digits)}`
}
