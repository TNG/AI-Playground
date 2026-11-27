/** Key by the strongest available identity (UUID → PCI id → name) so two
 *  identically-named GPUs don't collide and the selection stays stable. */
export function preferredDeviceKey(pref: PreferredDevice | null): string | null {
  if (!pref) return null
  return `gpu:${pref.uuid ?? pref.instanceId ?? pref.gpuDeviceId ?? pref.name}`
}

/**
 * The preference a picker shows: the stored one while the machine still offers it,
 * else the best available (options arrive best-first). A stored pick that is gone —
 * a removed GPU, or the CPU a GPU-only picker cannot show — must not leave the
 * picker empty.
 */
export function resolvePreferredDevice(
  stored: PreferredDevice | null | undefined,
  options: readonly { key: string; value: PreferredDevice }[],
): PreferredDevice | null {
  const key = preferredDeviceKey(stored ?? null)
  if (stored && key !== null && options.some((option) => option.key === key)) return stored
  return options[0]?.value ?? null
}
