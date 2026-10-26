import { describe, expect, it, vi } from 'vitest'
import { createModelDownloadQueue } from './modelDownloadQueue'
import type { ModelDownloadCallbacks } from '@/lib/modelDownloader'

const model = (name: string, backend = 'llama_cpp') =>
  ({ repo_id: `org/${name}`, type: 'llm', backend }) as DownloadModelParam
const X = model('x')
const Y = model('y')
const Z = model('z')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness() {
  const runs: {
    list: DownloadModelParam[]
    callbacks: ModelDownloadCallbacks & { signal: AbortSignal }
    finish: () => void
    fail: (error: Error) => void
  }[] = []
  const stop = vi.fn(async () => {})
  const queue = createModelDownloadQueue({
    downloader: () => ({
      download: (list, callbacks) =>
        new Promise<void>((finish, fail) => {
          runs.push({ list, callbacks, finish, fail })
          callbacks.signal.addEventListener('abort', () => fail(new Error('aborted')))
        }),
      stop,
    }),
  })
  return { queue, runs, stop }
}

describe('the Model Download queue', () => {
  it('splits what running or queued downloads cover from what is new', () => {
    const { queue } = harness()
    queue.start([X], ['a'], 'A')
    queue.start([Y], ['b'], 'B')
    const { coveredBy, uncovered } = queue.split([X, Y, Z, Z, model('x', 'openvino')])
    expect(coveredBy.map((d) => d.label)).toEqual(['A', 'B'])
    expect(uncovered).toEqual([Z, model('x', 'openvino')])
  })

  it('runs one download at a time, in the order they were started', async () => {
    const { queue, runs } = harness()
    queue.start([X], ['a'], 'A')
    queue.start([Y], ['b'], 'B')
    expect(runs.map((r) => r.list)).toEqual([[X]])
    expect(queue.snapshot('b')).toMatchObject({ status: 'queued', models: [Y] })
    runs[0].finish()
    await flush()
    expect(runs.map((r) => r.list)).toEqual([[X], [Y]])
    expect(queue.snapshot('b')).toMatchObject({ status: 'downloading' })
  })

  it('moves a waiter’s snapshot from downloading with progress to nothing once done', async () => {
    const { queue, runs } = harness()
    queue.start([X], ['a'], 'A')
    runs[0].callbacks.onProgress?.({
      repoId: 'org/x',
      percent: 42,
      taskPercent: 0,
      completed: 0,
      total: 1,
      speed: '5 MB/s',
    })
    expect(queue.snapshot('a')?.progress).toMatchObject({ percent: 42, speed: '5 MB/s' })
    const settled = queue.settled('a')
    runs[0].finish()
    await expect(settled).resolves.toEqual({ status: 'done' })
    expect(queue.snapshot('a')).toBeNull()
  })

  it('only starts what no Model Download covers and attaches every waiter to both', async () => {
    const { queue, runs } = harness()
    queue.start([X], ['a'], 'A')
    expect(queue.attach('b', [X, Y])).toEqual([Y])
    queue.start([X, Y], ['b'], 'B')
    expect(queue.snapshot('b')?.models).toEqual([X, Y])
    const settled = queue.settled('b')
    runs[0].finish()
    await flush()
    expect(runs[1].list).toEqual([Y])
    runs[1].finish()
    await expect(settled).resolves.toEqual({ status: 'done' })
  })

  it('cancels a download only when its last waiter leaves', async () => {
    const { queue, runs, stop } = harness()
    queue.start([X], ['a', 'b'], 'A')
    const b = queue.settled('b')
    queue.detach('a')
    expect(runs[0].callbacks.signal.aborted).toBe(false)
    queue.detach('b')
    await expect(b).resolves.toEqual({ status: 'cancelled' })
    expect(runs[0].callbacks.signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('waits for the stop to land before starting the next download', async () => {
    const { queue, runs, stop } = harness()
    let stopped: () => void = () => {}
    stop.mockImplementation(() => new Promise<void>((resolve) => (stopped = resolve)))
    const first = queue.start([X], ['a'], 'A')!
    queue.start([Y], ['b'], 'B')
    queue.cancel(first)
    await flush()
    expect(runs).toHaveLength(1)
    stopped()
    await flush()
    expect(runs.map((r) => r.list)).toEqual([[X], [Y]])
  })

  it('cancelling a queued download never stops the running one', () => {
    const { queue, runs, stop } = harness()
    queue.start([X], ['a'], 'A')
    const queued = queue.start([Y], ['b'], 'B')!
    queue.cancel(queued)
    expect(runs[0].callbacks.signal.aborted).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('resolves every waiter of a failed download with the error and its detail', async () => {
    const { queue, runs } = harness()
    queue.start([X], ['a', 'b'], 'A')
    const outcomes = [queue.settled('a'), queue.settled('b')]
    runs[0].callbacks.onError?.({
      errType: 'not_enough_disk_space',
      retryable: false,
      message: 'full',
    })
    runs[0].fail(new Error('full'))
    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toMatchObject({
        status: 'failed',
        detail: { errType: 'not_enough_disk_space' },
      })
    }
  })

  it('a waiter whose other download fails stops waiting on the rest, which nobody else needs', async () => {
    const { queue, runs } = harness()
    queue.start([X], ['a'], 'A')
    queue.start([Y], ['a'], 'A')
    const outcome = queue.settled('a')
    runs[0].fail(new Error('boom'))
    await expect(outcome).resolves.toMatchObject({ status: 'failed' })
    await flush()
    expect(runs).toHaveLength(1)
    expect(queue.downloads).toHaveLength(0)
  })
})
