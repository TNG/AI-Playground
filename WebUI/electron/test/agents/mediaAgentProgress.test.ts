import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { KernelMediaAgentEvent } from '@/types/kernelEvents'

const kernelListeners: Array<(event: unknown) => void> = []
vi.stubGlobal('window', {
  electronAPI: {
    onKernelEvent: (cb: (event: unknown) => void) => {
      kernelListeners.push(cb)
      return () => {
        const index = kernelListeners.indexOf(cb)
        if (index >= 0) kernelListeners.splice(index, 1)
      }
    },
    getKernelSnapshot: async () => ({
      scope: { kind: 'global' },
      sequence: 0,
      state: {
        services: [],
        agentTurns: [],
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    }),
  },
})

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: {} }),
}))

const { ensureMediaAgentEventWiring } = await import('@/assets/js/agents/mediaAgentProgress')
const { useMediaAgentRuns } = await import('@/assets/js/store/mediaAgentRuns')

let seq = 0
function send(runKey: string, ...events: KernelMediaAgentEvent['event'][]) {
  for (const event of events) {
    seq += 1
    const payload = { type: 'media-agent-event', runKey, event, seq, scope: { kind: 'run' } }
    for (const listener of [...kernelListeners]) listener(payload)
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  ensureMediaAgentEventWiring()
})

describe('media specialist progress events', () => {
  it('a run stopped mid-planning ends as failed and stops streaming its narration', () => {
    const runs = useMediaAgentRuns()
    send(
      'run-stop',
      { type: 'phase', phase: 'running-tool' },
      { type: 'tool-start', toolCallId: 'c1', toolName: 'comfyUI', input: { workflow: 'W1' } },
      { type: 'phase', phase: 'planning' },
      { type: 'narration-delta', kind: 'reasoning', text: 'Finishing up' },
    )
    expect(runs.run('run-stop')).toMatchObject({ state: 'running', phase: 'planning' })

    send('run-stop', { type: 'run-end', state: 'failed' })

    const run = runs.run('run-stop')
    expect(run).toMatchObject({ state: 'failed', narration: '' })
    expect(run?.steps.map((step) => step.state)).toEqual(['failed'])
  })

  it('a completed run ends as done', () => {
    const runs = useMediaAgentRuns()
    send('run-done', { type: 'phase', phase: 'planning' }, { type: 'run-end', state: 'done' })
    expect(runs.run('run-done')?.state).toBe('done')
  })

  it('an end event for a run this window never saw opens no row', () => {
    const runs = useMediaAgentRuns()
    send('run-unseen', { type: 'run-end', state: 'failed' })
    expect(runs.run('run-unseen')).toBeNull()
  })
})
