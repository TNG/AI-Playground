import { useMediaAgentRuns } from '../store/mediaAgentRuns'
import type { MediaItem } from '../store/imageGenerationPresets'
import { mediaEntriesOf } from '@/lib/mediaAgentResult'
import type { KernelMediaAgentEvent } from '@/types/kernelEvents'

/** Comfy-shaped entries carry everything a MediaItem needs except its state. */
function toMediaItems(output: unknown): MediaItem[] {
  return mediaEntriesOf(output).map((item) => ({ ...item, state: 'done' }) as MediaItem)
}

/** Row title inputs for the timeline: which workflow, and with what prompt. */
function stepDescriptor(input: unknown): { workflow?: string; prompt?: string } {
  const record = (input ?? {}) as Record<string, unknown>
  return {
    workflow: typeof record.workflow === 'string' ? record.workflow : undefined,
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
  }
}

/** Translates a run's kernel progress events into mediaAgentRuns store updates. */
function translateProgressEvent(runKey: string, event: KernelMediaAgentEvent['event']): void {
  const mediaRuns = useMediaAgentRuns()
  if (event.type === 'run-end') {
    mediaRuns.endRun(runKey, event.state)
    return
  }
  // The specialist runs in main, so the first kernel event has to open the
  // timeline row (request text is empty; the UI does not show it).
  if (!mediaRuns.run(runKey)) mediaRuns.beginRun(runKey, '')
  switch (event.type) {
    case 'phase':
      mediaRuns.setPhase(runKey, event.phase)
      break
    case 'narration-delta':
      mediaRuns.appendNarration(runKey, event.text)
      break
    case 'tool-start':
      mediaRuns.beginStep(runKey, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...stepDescriptor(event.input),
        label: 'Starting…',
      })
      break
    case 'tool-finish': {
      const output = (event.output ?? {}) as { success?: boolean; message?: string }
      mediaRuns.endStep(runKey, {
        toolCallId: event.toolCallId,
        media: toMediaItems(event.output),
        error: event.error ?? (output.success === false ? output.message : undefined),
      })
      break
    }
  }
}

// The nested loop runs in main; its live progress reaches the timeline as
// `media-agent-event` kernel events. One listener serves every run, keyed by
// runKey — registered on first use so module import alone (and unit tests)
// never subscribes.
let mediaKernelUnsubscribe: (() => void) | null = null
export function ensureMediaAgentEventWiring(): void {
  if (mediaKernelUnsubscribe) return
  const subscribe = window.electronAPI?.onKernelEvent
  if (!subscribe) return
  mediaKernelUnsubscribe = subscribe((event) => {
    if (event.type !== 'media-agent-event') return
    translateProgressEvent(event.runKey, event.event)
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    mediaKernelUnsubscribe?.()
    mediaKernelUnsubscribe = null
  })
}
