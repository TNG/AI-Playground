import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { KernelEvent, KernelQueueEvent } from '@/types/kernelEvents'

// The renderer's half of the orchestrator's queue events (step 7): a parked
// chat tool's activity is relabelled with its queue position and restored
// when its run starts. Panel runs carry no activityId and are ignored —
// their waiting state is the generation FSM's queued phase.

type Tap = (event: KernelEvent) => void

let taps: Tap[] = []

function emit(payload: KernelQueueEvent): void {
  const event = { ...payload, scope: { kind: 'global' }, seq: 1 } as KernelEvent
  for (const tap of taps) tap(event)
}

beforeEach(() => {
  setActivePinia(createPinia())
  taps = []
  globalThis.window = {
    electronAPI: {
      onKernelEvent: (tap: Tap) => {
        taps.push(tap)
        return () => {
          taps = taps.filter((t) => t !== tap)
        }
      },
      getLocaleSettings: async () => ({}),
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { stopQueueActivityProjection } = await import('@/lib/queueActivityProjection')
  stopQueueActivityProjection()
  vi.unstubAllGlobals()
  // @ts-expect-error test teardown of the fake window
  delete globalThis.window
})

describe('queue activity projection', () => {
  it('relabels a parked tool activity with its queue position and restores it', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const { useI18N } = await import('@/assets/js/store/i18n')
    const i18nState = useI18N().state
    i18nState.COM_ACTIVITY_QUEUED_BEHIND = 'Waiting for {count} generation(s) to finish'

    const activities = useActivities()
    const id = activities.begin({ category: 'tools', label: 'Generating image…' })

    startQueueActivityProjection()
    emit({
      type: 'queue-event',
      runKey: 'artifact-run-queued',
      kind: 'artifact',
      action: 'enqueued',
      queueDepth: 1,
      conversationKey: 'conv-1',
      activityId: id,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe(
      'Waiting for 2 generation(s) to finish',
    )

    emit({
      type: 'queue-event',
      runKey: 'artifact-run-queued',
      kind: 'artifact',
      action: 'started',
      queueDepth: 0,
      conversationKey: 'conv-1',
      activityId: id,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe('Generating image…')
  })

  it('ignores events without an activityId and duplicate enqueues', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const { useI18N } = await import('@/assets/js/store/i18n')
    useI18N().state.COM_ACTIVITY_QUEUED_BEHIND = 'Waiting for {count} generation(s) to finish'
    const activities = useActivities()
    const id = activities.begin({ category: 'tools', label: 'Creating media…' })

    startQueueActivityProjection()
    emit({
      type: 'queue-event',
      runKey: 'panel-run',
      kind: 'artifact',
      action: 'enqueued',
      queueDepth: 0,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe('Creating media…')

    emit({
      type: 'queue-event',
      runKey: 'dup',
      kind: 'media-request',
      action: 'enqueued',
      queueDepth: 0,
      activityId: id,
    })
    // A second enqueue for the same run keeps the first stash (the original
    // label), so the restore below cannot strand the relabelled text.
    emit({
      type: 'queue-event',
      runKey: 'dup',
      kind: 'media-request',
      action: 'enqueued',
      queueDepth: 0,
      activityId: id,
    })
    emit({
      type: 'queue-event',
      runKey: 'dup',
      kind: 'media-request',
      action: 'started',
      queueDepth: 0,
      activityId: id,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe('Creating media…')
  })

  it('restores the stashed label when a queued run finishes without starting', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const { useI18N } = await import('@/assets/js/store/i18n')
    useI18N().state.COM_ACTIVITY_QUEUED_BEHIND = 'Waiting for {count} generation(s) to finish'
    const activities = useActivities()
    const id = activities.begin({ category: 'tools', label: 'Generating image…' })

    startQueueActivityProjection()
    emit({
      type: 'queue-event',
      runKey: 'artifact-run-cancelled',
      kind: 'artifact',
      action: 'enqueued',
      queueDepth: 0,
      activityId: id,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe(
      'Waiting for 1 generation(s) to finish',
    )

    emit({
      type: 'queue-event',
      runKey: 'artifact-run-cancelled',
      kind: 'artifact',
      action: 'finished',
      queueDepth: 0,
      activityId: id,
    })
    expect(activities.activeItems.find((a) => a.id === id)?.label).toBe('Generating image…')
  })

  it('shows a waiting chat turn as queued on its conversation until it takes the place', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const { useI18N } = await import('@/assets/js/store/i18n')
    const i18nState = useI18N().state
    i18nState.COM_ACTIVITY_TURN_QUEUED_FOR_AGENT =
      'Queued ({position}), waiting for an agent turn to finish'
    i18nState.COM_ACTIVITY_TURN_QUEUED_FOR_CHAT =
      'Queued ({position}), waiting for a chat turn to finish'
    i18nState.HISTORY_QUEUE_ORDINAL_ONE = '{n}st'
    i18nState.HISTORY_QUEUE_ORDINAL_TWO = '{n}nd'
    i18nState.HISTORY_QUEUE_ORDINAL_OTHER = '{n}th'
    const activities = useActivities()

    startQueueActivityProjection()
    const turn = { type: 'queue-event', runKey: 'turn-chat', kind: 'text', work: 'chat' } as const
    emit({
      ...turn,
      action: 'enqueued',
      queueDepth: 0,
      position: 2,
      holder: 'agent',
      conversationKey: 'conv-1',
    })
    expect(activities.chatActivity('conv-1')?.label).toBe(
      'Queued (2nd), waiting for an agent turn to finish',
    )

    emit({
      ...turn,
      action: 'moved',
      queueDepth: 0,
      position: 1,
      holder: 'chat',
      conversationKey: 'conv-1',
    })
    expect(activities.chatActivity('conv-1')?.label).toBe(
      'Queued (1st), waiting for a chat turn to finish',
    )

    emit({ ...turn, action: 'started', queueDepth: 0, conversationKey: 'conv-1' })
    expect(activities.chatActivity('conv-1')).toBeNull()
  })

  it('drops the queued line when a waiting chat turn is stopped', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const activities = useActivities()

    startQueueActivityProjection()
    const turn = { type: 'queue-event', runKey: 'turn-chat', kind: 'text', work: 'chat' } as const
    emit({
      ...turn,
      action: 'enqueued',
      queueDepth: 0,
      position: 1,
      holder: 'agent',
      conversationKey: 'conv-1',
    })
    expect(activities.chatActivity('conv-1')).not.toBeNull()
    emit({ ...turn, action: 'finished', queueDepth: 0, conversationKey: 'conv-1' })
    expect(activities.chatActivity('conv-1')).toBeNull()
  })

  it('leaves waiting agent turns to the session view', async () => {
    const { startQueueActivityProjection } = await import('@/lib/queueActivityProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const activities = useActivities()

    startQueueActivityProjection()
    emit({
      type: 'queue-event',
      runKey: 'turn-agent',
      kind: 'text',
      work: 'agent',
      action: 'enqueued',
      queueDepth: 0,
      position: 1,
      holder: 'chat',
      conversationKey: 'session-b',
    })
    expect(activities.chatActivity('session-b')).toBeNull()
  })
})
