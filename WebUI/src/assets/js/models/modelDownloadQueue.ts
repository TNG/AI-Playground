import { reactive } from 'vue'
import type {
  ModelDownloadCallbacks,
  ModelDownloadError,
  ModelDownloadProgress,
} from '@/lib/modelDownloader'

/**
 * The Model Download queue (docs/adr/0005): every download the app starts runs
 * through it, one at a time, and any number of turns ("waiters") can wait on the
 * same Model Download. The ai-backend has a single downloader, so a second
 * request would stop the first — this queue is what guarantees it never gets one.
 */

export type ModelDownloadOutcome =
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: Error; detail?: ModelDownloadError }

export type ModelDownload = {
  id: string
  models: DownloadModelParam[]
  /** Who started it, for "Already downloading for <label>". */
  label: string
  waiters: string[]
  status: 'queued' | 'downloading'
  progress: ModelDownloadProgress | null
}

export type ModelDownloadWait = {
  status: 'queued' | 'downloading'
  /** Every model the waiter waits on, across its Model Downloads. */
  models: DownloadModelParam[]
  /** The running download's progress; null until it reports or while queued. */
  progress: ModelDownloadProgress | null
  /** The Model Downloads it waits on, oldest first. */
  downloadIds: string[]
}

export type ModelDownloadListener = {
  onProgress?: (progress: ModelDownloadProgress) => void
  onSettled?: (outcome: ModelDownloadOutcome) => void
}

export type ModelDownloader = {
  download: (
    list: DownloadModelParam[],
    options: ModelDownloadCallbacks & { signal: AbortSignal },
  ) => Promise<void>
  /** Stops the ai-backend's current download; only ever called for the queue's own. */
  stop: () => Promise<void>
  onModelCompleted?: () => void
}

export type ModelDownloadQueue = ReturnType<typeof createModelDownloadQueue>

export function modelKey(model: DownloadModelParam): string {
  return `${model.backend}|${model.type}|${model.repo_id}`
}

function uniqueModels(models: DownloadModelParam[]): DownloadModelParam[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    const key = modelKey(model)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Waiter = {
  downloads: Set<string>
  promise: Promise<ModelDownloadOutcome>
  resolve: (outcome: ModelDownloadOutcome) => void
}

export function createModelDownloadQueue(deps: {
  downloader: () => ModelDownloader | null
  newId?: () => string
}) {
  let counter = 0
  const newId = deps.newId ?? (() => `md-${++counter}`)
  const downloads = reactive<ModelDownload[]>([])
  const waiters = new Map<string, Waiter>()
  const controllers = new Map<string, AbortController>()
  const listeners = new Map<string, Set<ModelDownloadListener>>()
  let stopping: Promise<void> | null = null

  function find(id: string): ModelDownload | undefined {
    return downloads.find((download) => download.id === id)
  }

  function covering(model: DownloadModelParam): ModelDownload | undefined {
    const key = modelKey(model)
    return downloads.find((download) => download.models.some((m) => modelKey(m) === key))
  }

  /** The Model Downloads already covering some of `models`, and the models none covers. */
  function split(models: DownloadModelParam[]) {
    const coveredBy: ModelDownload[] = []
    const uncovered: DownloadModelParam[] = []
    for (const model of uniqueModels(models)) {
      const download = covering(model)
      if (!download) uncovered.push(model)
      else if (!coveredBy.includes(download)) coveredBy.push(download)
    }
    return { coveredBy, uncovered }
  }

  function waiterRecord(waiter: string): Waiter {
    const existing = waiters.get(waiter)
    if (existing) return existing
    let resolve: (outcome: ModelDownloadOutcome) => void = () => {}
    const promise = new Promise<ModelDownloadOutcome>((r) => {
      resolve = r
    })
    const record = { downloads: new Set<string>(), promise, resolve }
    waiters.set(waiter, record)
    return record
  }

  function attachTo(download: ModelDownload, waiter: string): void {
    if (!download.waiters.includes(waiter)) download.waiters.push(waiter)
    waiterRecord(waiter).downloads.add(download.id)
  }

  function resolveWaiter(waiter: string, outcome: ModelDownloadOutcome): void {
    const record = waiters.get(waiter)
    if (!record) return
    waiters.delete(waiter)
    for (const id of record.downloads) {
      const download = find(id)
      if (!download) continue
      download.waiters = download.waiters.filter((w) => w !== waiter)
      if (download.waiters.length === 0) settle(download, { status: 'cancelled' })
    }
    record.resolve(outcome)
  }

  /** Attaches `waiter` to the Model Downloads already covering `models`; returns the rest. */
  function attach(waiter: string, models: DownloadModelParam[]): DownloadModelParam[] {
    const { coveredBy, uncovered } = split(models)
    for (const download of coveredBy) attachTo(download, waiter)
    return uncovered
  }

  /** After a yes: queues what no Model Download covers yet and attaches every waiter. */
  function start(models: DownloadModelParam[], waiterIds: string[], label: string): string | null {
    const { coveredBy, uncovered } = split(models)
    let created: ModelDownload | null = null
    if (uncovered.length > 0) {
      created = {
        id: newId(),
        models: uncovered,
        label,
        waiters: [],
        status: 'queued',
        progress: null,
      }
      downloads.push(created)
      // Read back through the reactive array so later mutations are tracked.
      created = find(created.id)!
    }
    for (const waiter of waiterIds) {
      for (const download of coveredBy) attachTo(download, waiter)
      if (created) attachTo(created, waiter)
    }
    pump()
    return created?.id ?? null
  }

  function settled(waiter: string): Promise<ModelDownloadOutcome> {
    return waiters.get(waiter)?.promise ?? Promise.resolve({ status: 'done' })
  }

  /** A turn stopped waiting; a Model Download nobody waits on any more is cancelled. */
  function detach(waiter: string): void {
    resolveWaiter(waiter, { status: 'cancelled' })
  }

  /** Ends a Model Download for every waiter; each is told it was declined. */
  function cancel(id: string): void {
    const download = find(id)
    if (download) settle(download, { status: 'cancelled' })
  }

  function settle(download: ModelDownload, outcome: ModelDownloadOutcome): void {
    const index = downloads.indexOf(download)
    if (index === -1) return
    downloads.splice(index, 1)
    const wasRunning = download.status === 'downloading'
    const controller = controllers.get(download.id)
    controllers.delete(download.id)
    controller?.abort()
    if (wasRunning && outcome.status === 'cancelled') {
      const stop = deps.downloader()?.stop() ?? Promise.resolve()
      stopping = stop
        .catch(() => {})
        .finally(() => {
          stopping = null
          pump()
        })
    }
    for (const listener of listeners.get(download.id) ?? []) listener.onSettled?.(outcome)
    listeners.delete(download.id)
    for (const waiter of [...download.waiters]) {
      const record = waiters.get(waiter)
      if (!record) continue
      record.downloads.delete(download.id)
      if (outcome.status !== 'done') resolveWaiter(waiter, outcome)
      else if (record.downloads.size === 0) {
        waiters.delete(waiter)
        record.resolve(outcome)
      }
    }
    pump()
  }

  function pump(): void {
    if (stopping) return
    if (downloads.some((download) => download.status === 'downloading')) return
    const next = downloads.find((download) => download.status === 'queued')
    if (next) run(next)
  }

  function run(download: ModelDownload): void {
    const downloader = deps.downloader()
    if (!downloader) {
      settle(download, {
        status: 'failed',
        error: new Error('No model downloader is available'),
      })
      return
    }
    download.status = 'downloading'
    const controller = new AbortController()
    controllers.set(download.id, controller)
    let detail: ModelDownloadError | undefined
    downloader
      .download(download.models, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted) return
          download.progress = progress
          for (const listener of listeners.get(download.id) ?? []) listener.onProgress?.(progress)
        },
        onModelCompleted: () => downloader.onModelCompleted?.(),
        onError: (error) => {
          detail = error
        },
      })
      .then(
        () => {
          if (!controller.signal.aborted) settle(download, { status: 'done' })
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          const failure = error instanceof Error ? error : new Error(String(error))
          settle(download, { status: 'failed', error: failure, detail })
        },
      )
  }

  /** Hears one Model Download's progress and outcome; returns the unsubscribe. */
  function watchDownload(id: string, listener: ModelDownloadListener): () => void {
    if (!find(id)) return () => {}
    const set = listeners.get(id) ?? new Set<ModelDownloadListener>()
    set.add(listener)
    listeners.set(id, set)
    return () => set.delete(listener)
  }

  /** What `waiter` is waiting on, reactively; null once it waits on nothing. */
  function snapshot(waiter: string): ModelDownloadWait | null {
    const mine = downloads.filter((download) => download.waiters.includes(waiter))
    if (mine.length === 0) return null
    const running = mine.find((download) => download.status === 'downloading')
    return {
      status: running ? 'downloading' : 'queued',
      models: mine.flatMap((download) => download.models),
      progress: running?.progress ?? null,
      downloadIds: mine.map((download) => download.id),
    }
  }

  function downloadsOf(waiter: string): ModelDownload[] {
    return downloads.filter((download) => download.waiters.includes(waiter))
  }

  return {
    downloads,
    split,
    attach,
    start,
    settled,
    detach,
    cancel,
    watchDownload,
    snapshot,
    downloadsOf,
  }
}

let downloader: ModelDownloader | null = null

export function registerModelDownloader(next: ModelDownloader | null): void {
  downloader = next
}

let shared = createModelDownloadQueue({ downloader: () => downloader })

/** The app's one Model Download queue. */
export function modelDownloads(): ModelDownloadQueue {
  return shared
}

export function resetModelDownloadsForTest(): void {
  shared = createModelDownloadQueue({ downloader: () => downloader })
}

/** A waiter's outcome as the caller of a download sees it: resolves on done, throws otherwise. */
export function throwUnlessDone(outcome: ModelDownloadOutcome, cancellation: () => unknown): void {
  if (outcome.status === 'done') return
  if (outcome.status === 'cancelled') throw cancellation()
  throw outcome.error
}
