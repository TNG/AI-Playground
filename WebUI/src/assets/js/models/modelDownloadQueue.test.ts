import { describe, expect, it, vi } from 'vitest'
import { createModelDownloadQueue } from './modelDownloadQueue'
import type { ModelDownloadCallbacks } from '@/lib/modelDownloader'

const model = (name: string, backend = 'llama_cpp') =>
  ({ repo_id: `org/${name}`, type: 'llm', backend }) as DownloadModelParam
const X = model('x')
const Y = model('y')
const Z = model('z')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { noDownloader?: boolean } = {}) {
  const runs: {
    list: DownloadModelParam[]
    callbacks: ModelDownloadCallbacks & { signal: AbortSignal }
    finish: () => void
    fail: (error: Error) => void
  }[] = []
  const stop = vi.fn(async () => {})
  const onStart = vi.fn()
  const queue = createModelDownloadQueue({
    downloader: () =>
      options.noDownloader
        ? null
        : {
            download: (list, callbacks) =>
              new Promise<void>((finish, fail) => {
                runs.push({ list, callbacks, finish, fail })
                callbacks.signal.addEventListener('abort', () => fail(new Error('aborted')))
              }),
            stop,
          },
    onStart,
  })
  /** A request that says yes to `models` straight away. */
  const confirmed = (group: string, models: DownloadModelParam[], label = group) => {
    const waiter = queue.waiter(group)
    waiter.start(models, label)
    return waiter
  }
  return { queue, runs, stop, onStart, confirmed }
}

describe('the Model Download queue', () => {
  it('splits what running or queued downloads cover from what is new', () => {
    const { queue, confirmed } = harness()
    confirmed('a', [X], 'A')
    confirmed('b', [Y], 'B')
    const { coveredBy, uncovered } = queue.split([X, Y, Z, Z, model('x', 'openvino')])
    expect(coveredBy.map((d) => d.label)).toEqual(['A', 'B'])
    expect(uncovered).toEqual([Z, model('x', 'openvino')])
  })

  it('runs one download at a time, in the order they were started', async () => {
    const { queue, runs, confirmed } = harness()
    confirmed('a', [X])
    confirmed('b', [Y])
    expect(runs.map((r) => r.list)).toEqual([[X]])
    expect(queue.snapshot('b')).toMatchObject({ status: 'queued', models: [Y] })
    runs[0].finish()
    await flush()
    expect(runs.map((r) => r.list)).toEqual([[X], [Y]])
    expect(queue.snapshot('b')).toMatchObject({ status: 'downloading' })
  })

  it('moves a group’s snapshot from downloading with progress to nothing once done', async () => {
    const { queue, runs, confirmed } = harness()
    const a = confirmed('a', [X])
    runs[0].callbacks.onProgress?.({
      repoId: 'org/x',
      percent: 42,
      taskPercent: 0,
      completed: 0,
      total: 1,
      speed: '5 MB/s',
    })
    expect(queue.snapshot('a')?.progress).toMatchObject({ percent: 42, speed: '5 MB/s' })
    runs[0].finish()
    await expect(a.settled).resolves.toEqual({ status: 'done' })
    expect(queue.snapshot('a')).toBeNull()
  })

  it('only starts what no Model Download covers and waits on both', async () => {
    const { queue, runs, confirmed } = harness()
    confirmed('a', [X])
    const b = queue.waiter('b')
    expect(b.attach([X, Y])).toEqual([Y])
    b.start([X, Y], 'B')
    expect(queue.snapshot('b')?.models).toEqual([X, Y])
    runs[0].finish()
    await flush()
    expect(runs[1].list).toEqual([Y])
    runs[1].finish()
    await expect(b.settled).resolves.toEqual({ status: 'done' })
  })

  it('does not settle "done" while its question is still open', async () => {
    const { queue, runs, confirmed } = harness()
    confirmed('a', [X])
    const asking = queue.waiter('b')
    asking.attach([X, Y])
    let outcome: unknown = null
    void asking.settled.then((o) => (outcome = o))
    runs[0].finish()
    await flush()
    expect(outcome).toBeNull()
    asking.release()
    await flush()
    expect(outcome).toEqual({ status: 'done' })
  })

  it('a download it waits on failing mid-question settles it, and a later yes changes nothing', async () => {
    const { queue, runs, confirmed } = harness()
    confirmed('a', [X])
    const asking = queue.waiter('b')
    asking.attach([X, Y])
    runs[0].fail(new Error('disk full'))
    await expect(asking.settled).resolves.toMatchObject({ status: 'failed' })
    expect(asking.start([X, Y], 'B')).toBeNull()
    await expect(asking.settled).resolves.toMatchObject({ status: 'failed' })
    expect(runs).toHaveLength(1)
  })

  it('reports a download that could not even start as failed, not done', async () => {
    const { queue } = harness({ noDownloader: true })
    const waiter = queue.waiter('a')
    waiter.start([X], 'A')
    await expect(waiter.settled).resolves.toMatchObject({ status: 'failed' })
  })

  it('keeps two requests of one session apart', async () => {
    const { queue, runs } = harness()
    const readiness = queue.waiter('session')
    const media = queue.waiter('session')
    readiness.start([X], 'S')
    media.start([X], 'S')
    readiness.detach()
    await expect(readiness.settled).resolves.toEqual({ status: 'cancelled' })
    expect(runs[0].callbacks.signal.aborted).toBe(false)
    runs[0].finish()
    await expect(media.settled).resolves.toEqual({ status: 'done' })
  })

  it('cancels a download only when its last waiter leaves', async () => {
    const { queue, runs, stop } = harness()
    const a = queue.waiter('a')
    const b = queue.waiter('b')
    a.start([X], 'A')
    b.start([X], 'B')
    a.detach()
    expect(runs[0].callbacks.signal.aborted).toBe(false)
    b.detach()
    await expect(b.settled).resolves.toEqual({ status: 'cancelled' })
    expect(runs[0].callbacks.signal.aborted).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('detaches every request of a group that went away', async () => {
    const { queue, runs, confirmed } = harness()
    const first = confirmed('chat-1', [X])
    const second = confirmed('chat-1', [Y])
    queue.detachGroup('chat-1')
    await expect(first.settled).resolves.toEqual({ status: 'cancelled' })
    await expect(second.settled).resolves.toEqual({ status: 'cancelled' })
    expect(runs[0].callbacks.signal.aborted).toBe(true)
  })

  it('waits for the stop to land before starting the next download', async () => {
    const { queue, runs, stop, confirmed } = harness()
    let stopped: () => void = () => {}
    stop.mockImplementation(() => new Promise<void>((resolve) => (stopped = resolve)))
    confirmed('a', [X])
    confirmed('b', [Y])
    queue.cancel(queue.downloads[0].id)
    await flush()
    expect(runs).toHaveLength(1)
    stopped()
    await flush()
    expect(runs.map((r) => r.list)).toEqual([[X], [Y]])
  })

  it('cancelling a queued download never stops the running one', () => {
    const { queue, runs, stop, confirmed } = harness()
    confirmed('a', [X])
    confirmed('b', [Y])
    queue.cancel(queue.downloads[1].id)
    expect(runs[0].callbacks.signal.aborted).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('resolves every waiter of a failed download with the error and its detail', async () => {
    const { runs, confirmed } = harness()
    const waiters = [confirmed('a', [X]), confirmed('b', [X])]
    runs[0].callbacks.onError?.({
      errType: 'not_enough_disk_space',
      retryable: false,
      message: 'full',
    })
    runs[0].fail(new Error('full'))
    for (const waiter of waiters) {
      await expect(waiter.settled).resolves.toMatchObject({
        status: 'failed',
        detail: { errType: 'not_enough_disk_space' },
      })
    }
  })

  it('a waiter whose other download fails stops waiting on the rest, which nobody else needs', async () => {
    const { queue, runs, confirmed } = harness()
    const first = confirmed('a', [X])
    const both = confirmed('b', [X, Y])
    first.detach()
    runs[0].fail(new Error('boom'))
    await expect(both.settled).resolves.toMatchObject({ status: 'failed' })
    await flush()
    expect(queue.downloads).toHaveLength(0)
    expect(runs).toHaveLength(1)
  })

  it('tells who queued a download, so other questions it covers can close', () => {
    const { queue, onStart } = harness()
    const waiter = queue.waiter('a')
    waiter.start([X], 'A')
    expect(onStart).toHaveBeenCalledWith('A', waiter.id)
    queue.waiter('b').start([X], 'B')
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})
