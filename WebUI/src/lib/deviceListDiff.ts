import type {
  DeviceDebugEntry,
  DeviceDebugHardwareEntry,
  DeviceDebugSnapshot,
} from '@/types/deviceDebug'

type Identified = {
  identity: string
  label: string
  id: string
  name: string
  uuid?: string | null
}

export type DeviceListChange = {
  added: string[]
  removed: string[]
  reordered: Array<{ position: number; before: string; after: string }>
  changed: boolean
}

export type DeviceSelectionDrift = {
  key: string
  persistedId: string
  persistedUuid?: string
  beforeId: string | null
  beforeName: string | null
  afterId: string | null
  afterName: string | null
  kind: 'same' | 'moved' | 'missing' | 'unknown'
}

export type DeviceDebugDiff = {
  hardware: DeviceListChange
  backends: Record<string, DeviceListChange>
  selections: DeviceSelectionDrift[]
}

const normalize = (value: string) => value.trim().toLowerCase()

function identified(
  entry: { id: string; name: string; uuid?: string | null },
  identity: string,
): Identified {
  return { identity, label: entry.name, id: entry.id, name: entry.name, uuid: entry.uuid }
}

function backendEntries(entries: DeviceDebugEntry[]): Identified[] {
  return entries.map((entry) =>
    identified(
      entry,
      entry.uuid ? `uuid:${normalize(entry.uuid)}` : `name:${normalize(entry.name)}`,
    ),
  )
}

function hardwareEntries(entries: DeviceDebugHardwareEntry[]): Identified[] {
  return entries.map((entry) =>
    identified(
      { id: entry.device, name: entry.name, uuid: entry.uuid },
      entry.uuid
        ? `uuid:${normalize(entry.uuid)}`
        : entry.gpuDeviceId
          ? `pci:${normalize(entry.gpuDeviceId)}|${normalize(entry.name)}`
          : `name:${normalize(entry.name)}`,
    ),
  )
}

function diffList(before: Identified[], after: Identified[]): DeviceListChange {
  const beforeCounts = new Map<string, number>()
  for (const entry of before) {
    beforeCounts.set(entry.identity, (beforeCounts.get(entry.identity) ?? 0) + 1)
  }
  const afterCounts = new Map<string, number>()
  for (const entry of after) {
    afterCounts.set(entry.identity, (afterCounts.get(entry.identity) ?? 0) + 1)
  }

  const added: string[] = []
  const seenAdded = new Map<string, number>()
  for (const entry of after) {
    const expected = beforeCounts.get(entry.identity) ?? 0
    const seen = (seenAdded.get(entry.identity) ?? 0) + 1
    seenAdded.set(entry.identity, seen)
    if (seen > expected) added.push(entry.label)
  }

  const removed: string[] = []
  const seenRemoved = new Map<string, number>()
  for (const entry of before) {
    const expected = afterCounts.get(entry.identity) ?? 0
    const seen = (seenRemoved.get(entry.identity) ?? 0) + 1
    seenRemoved.set(entry.identity, seen)
    if (seen > expected) removed.push(entry.label)
  }

  const reordered: DeviceListChange['reordered'] = []
  const sameMembers = added.length === 0 && removed.length === 0
  if (sameMembers && before.length === after.length) {
    for (let index = 0; index < before.length; index++) {
      if (before[index].identity !== after[index].identity) {
        reordered.push({ position: index, before: before[index].label, after: after[index].label })
      }
    }
  }

  return {
    added,
    removed,
    reordered,
    changed: added.length > 0 || removed.length > 0 || reordered.length > 0,
  }
}

function resolveSelection(
  entries: Identified[],
  id: string,
  uuid?: string,
): Identified | undefined {
  if (uuid) {
    const byUuid = entries.find((entry) => entry.uuid && normalize(entry.uuid) === normalize(uuid))
    if (byUuid) return byUuid
  }
  return entries.find((entry) => entry.id === id)
}

function selectionDrifts(
  baseline: DeviceDebugSnapshot,
  current: DeviceDebugSnapshot,
): DeviceSelectionDrift[] {
  const drifts: DeviceSelectionDrift[] = []
  for (const [key, persistedId] of Object.entries(current.persisted.lastSelectedDevicePerBackend)) {
    const serviceName = key.includes(':') ? key.slice(0, key.indexOf(':')) : key
    const beforeList = baseline.backends[serviceName]?.devices
    const afterList = current.backends[serviceName]?.devices
    if (!beforeList || !afterList) continue

    const persistedUuid = current.persisted.lastSelectedDeviceUuidPerBackend[key]
    const before = resolveSelection(backendEntries(beforeList), persistedId, persistedUuid)
    const after = resolveSelection(backendEntries(afterList), persistedId, persistedUuid)

    let kind: DeviceSelectionDrift['kind']
    if (!after) kind = 'missing'
    else if (!before) kind = 'unknown'
    else if (persistedUuid && before.uuid && after.uuid) {
      kind = normalize(before.uuid) === normalize(after.uuid) ? 'same' : 'moved'
    } else {
      kind = before.id === after.id && before.name === after.name ? 'same' : 'moved'
    }

    drifts.push({
      key,
      persistedId,
      ...(persistedUuid ? { persistedUuid } : {}),
      beforeId: before?.id ?? null,
      beforeName: before?.name ?? null,
      afterId: after?.id ?? null,
      afterName: after?.name ?? null,
      kind,
    })
  }
  return drifts
}

/**
 * Compare a fresh device capture against a saved baseline. Identity is a UUID
 * when one is reported, otherwise the device name — never the list position,
 * because position is exactly what changes and silently re-points a selection.
 */
export function diffDeviceSnapshots(
  baseline: DeviceDebugSnapshot,
  current: DeviceDebugSnapshot,
): DeviceDebugDiff {
  const backends: Record<string, DeviceListChange> = {}
  for (const [name, probe] of Object.entries(current.backends)) {
    const before = baseline.backends[name]?.devices ?? []
    backends[name] = diffList(backendEntries(before), backendEntries(probe.devices))
  }
  return {
    hardware: diffList(hardwareEntries(baseline.hardware), hardwareEntries(current.hardware)),
    backends,
    selections: selectionDrifts(baseline, current),
  }
}
