import type { BrowserWindow } from 'electron'
import { appLoggerInstance } from '../logging/logger'
import type {
  AgentTurnSnapshot,
  KernelAgentToolImageEvent,
  KernelEvent,
  KernelEventPayload,
  KernelEventScope,
  KernelSnapshot,
} from '@/types/kernelEvents'

const appLogger = appLoggerInstance

// ── Kernel event bus (main side, docs/architecture-target.md §4.6) ────────────
//
// Every main→renderer notification crosses one ordered stream: events are
// stamped with a scope and a single sequence number, and the renderer
// projection hydrates with a listener-first snapshot handshake (subscribe,
// buffer, install at sequence N, apply events above N). Point-to-point
// `webContents.send` channels this replaces: 'serviceInfoUpdate',
// 'agentMode:streamChunk', 'agentMode:toolProgress', 'agentMode:toolImage',
// 'agentMode:turnDone'. ('agentMode:executeTool' stays: it is a request the
// renderer answers, not a notification.)
//
// The bus also owns the window it sends to. Services used to capture the
// BrowserWindow they were constructed with, so after the app window was
// recreated (macOS close + dock re-activate) their status pushes went to a
// destroyed webContents and the new renderer never learned anything. Main sets
// the current window here on every createWindow().

const KERNEL_EVENT_CHANNEL = 'kernel:event'

let currentWin: BrowserWindow | null = null
let sequence = 0

export function setKernelEventWindow(win: BrowserWindow | null): void {
  currentWin = win
}

/** The window main currently renders into — never a stale capture. */
export function getKernelEventWindow(): BrowserWindow | null {
  return currentWin
}

function emit(payload: KernelEventPayload, scope: KernelEventScope): void {
  const event = { ...payload, scope, seq: ++sequence } as KernelEvent
  const target = currentWin
  if (!target || target.isDestroyed()) return
  try {
    target.webContents.send(KERNEL_EVENT_CHANNEL, event)
  } catch (error) {
    // A destroyed-but-not-yet-collected webContents throws; events are
    // fire-and-forget so the drop is logged, not fatal.
    appLogger.warn(`kernel event ${payload.type} dropped: ${String(error)}`, 'kernel')
  }
}

// ── Service status ────────────────────────────────────────────────────────────

const services = new Map<string, unknown>()

/** Push a backend service's status to the renderer and record it for snapshots. */
export function emitServiceUpdate(info: unknown): void {
  const record = info as { serviceName?: string }
  if (record?.serviceName) services.set(record.serviceName, info)
  emit({ type: 'service', info }, { kind: 'global' })
}

// ── Agent turn accumulator ─────────────────────────────────────────────────────

let activeTurn: AgentTurnSnapshot | null = null

/** Track a turn main is about to run, so snapshots can name it. */
export function beginAgentTurnSnapshot(turnId: string): void {
  activeTurn = { turnId, chunks: [], toolProgress: {}, toolImages: {} }
}

export function emitAgentChunk(turnId: string, chunk: unknown): void {
  if (activeTurn?.turnId === turnId) activeTurn.chunks.push(chunk)
  emit({ type: 'agent-chunk', turnId, chunk }, { kind: 'run', runId: turnId })
}

export function emitAgentToolProgress(
  turnId: string,
  toolCallId: string,
  toolName: string,
  text: string,
): void {
  if (activeTurn?.turnId === turnId) activeTurn.toolProgress[toolCallId] = text
  emit(
    { type: 'agent-tool-progress', turnId, toolCallId, toolName, text },
    { kind: 'run', runId: turnId },
  )
}

export function emitAgentToolImage(toolCallId: string, dataUri: string, label: string): void {
  const event: KernelAgentToolImageEvent = { type: 'agent-tool-image', toolCallId, dataUri, label }
  if (activeTurn) {
    const shown = activeTurn.toolImages[toolCallId] ?? []
    activeTurn.toolImages[toolCallId] = [...shown, event]
  }
  emit(event, { kind: 'run', runId: activeTurn?.turnId ?? '' })
}

export function emitAgentTurnDone(turnId: string): void {
  emit({ type: 'agent-turn-done', turnId }, { kind: 'run', runId: turnId })
  if (activeTurn?.turnId === turnId) activeTurn = null
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

/**
 * The projection's hydration state. `sequence` is the bus's last stamped seq:
 * the renderer applies only buffered events above it, so nothing recorded in
 * this snapshot can be double-applied.
 */
export function getKernelSnapshot(): KernelSnapshot {
  return {
    scope: { kind: 'global' },
    sequence,
    state: {
      services: [...services.values()],
      activeTurn: activeTurn ? { ...activeTurn } : null,
    },
  }
}

// Test seam: reset module state between unit tests.
export function resetKernelBusForTest(): void {
  currentWin = null
  sequence = 0
  services.clear()
  activeTurn = null
}
