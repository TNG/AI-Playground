import { reactive } from 'vue'
import type {
  ModelDownloadCallbacks,
  ModelDownloadError,
  ModelDownloadProgress,
} from '@/lib/modelDownloader'

/**
 * The Model Download queue (docs/adr/0005): every download the app starts runs
 * through it, one at a time, and any number of waiters can wait on the same Model
 * Download. The ai-backend has a single downloader, so a second request would stop
 * the first — this queue is what guarantees it never gets one.
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

/** What a session or conversation is waiting on, for its download card. */
export type ModelDownloadWait = {
  status: 'queued' | 'downloading'
  models: DownloadModelParam[]
  progress: ModelDownloadProgress | null
  downloadIds: string[]
}

export type ModelDownloadListener = {
  /** It left the queue and the ai-backend is downloading it now. */
  onStart?: () => void
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

/**
 * One request's wait. It is held while its Download Question is open, so it cannot
 * settle "done" before the answer, and it settles exactly once: a download it waits
 * on failing or being cancelled settles it at once, even mid-question.
 */
export type ModelDownloadWaiter = {
  id: string
  /** The session or conversation it waits for, which shows the download card. */
  group: string
  /** Waits on the Model Downloads already covering `models`; returns the rest. */
  attach: (models: DownloadModelParam[]) => DownloadModelParam[]
  /** After a yes: queues what nothing covers yet, waits on all of it, stops holding. */
  start: (models: DownloadModelParam[], label: string) => string | null
  /** Stops holding: settles "done" once nothing it waits on is left. */
  release: () => void
  /** Stops waiting; a Model Download nobody waits on any more is cancelled. */
  detach: () => void
  settled: Promise<ModelDownloadOutcome>
  downloads: () => ModelDownload[]
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

type WaiterRecord = {
  id: string
  group: string
  downloads: Set<string>
  held: boolean
  outcome: ModelDownloadOutcome | null
  resolve: (outcome: ModelDownloadOutcome) => void
}

export function createModelDownloadQueue(deps: {
  downloader: () => ModelDownloader | null
  /** A Model Download was queued for `waiterId`; other questions it covers can close. */
  onStart?: (label: string, waiterId: string) => void
}) {
  let counter = 0
  const downloads = reactive<ModelDownload[]>([])
  const records = new Map<string, WaiterRecord>()
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

  function attachTo(download: ModelDownload, record: WaiterRecord): void {
    if (!download.waiters.includes(record.id)) download.waiters.push(record.id)
    record.downloads.add(download.id)
  }

  function finish(record: WaiterRecord, outcome: ModelDownloadOutcome): void {
    if (record.outcome) return
    record.outcome = outcome
    records.delete(record.id)
    for (const id of record.downloads) {
      const download = find(id)
      if (!download) continue
      download.waiters = download.waiters.filter((w) => w !== record.id)
      if (download.waiters.length === 0) settle(download, { status: 'cancelled' })
    }
    record.downloads.clear()
    record.resolve(outcome)
  }

  function finishIfDone(record: WaiterRecord): void {
    if (!record.held && record.downloads.size === 0) finish(record, { status: 'done' })
  }

  function waiter(group: string): ModelDownloadWaiter {
    let resolve: (outcome: ModelDownloadOutcome) => void = () => {}
    const settled = new Promise<ModelDownloadOutcome>((r) => (resolve = r))
    const record: WaiterRecord = {
      id: `w-${++counter}`,
      group,
      downloads: new Set(),
      held: true,
      outcome: null,
      resolve,
    }
    records.set(record.id, record)
    return {
      id: record.id,
      group,
      attach: (models) => {
        const { coveredBy, uncovered } = split(models)
        if (record.outcome) return uncovered
        for (const download of coveredBy) attachTo(download, record)
        return uncovered
      },
      start: (models, label) => {
        if (record.outcome) return null
        const { coveredBy, uncovered } = split(models)
        for (const download of coveredBy) attachTo(download, record)
        let created: ModelDownload | undefined
        if (uncovered.length > 0) {
          const id = `md-${++counter}`
          downloads.push({
            id,
            models: uncovered,
            label,
            waiters: [],
            status: 'queued',
            progress: null,
          })
          created = find(id)!
          attachTo(created, record)
        }
        record.held = false
        if (created) deps.onStart?.(label, record.id)
        pump()
        finishIfDone(record)
        return created?.id ?? null
      },
      release: () => {
        record.held = false
        finishIfDone(record)
      },
      detach: () => finish(record, { status: 'cancelled' }),
      settled,
      downloads: () => downloads.filter((download) => record.downloads.has(download.id)),
    }
  }

  /** Ends a Model Download for every waiter; each is told it was declined. */
  function cancel(id: string): void {
    const download = find(id)
    if (download) settle(download, { status: 'cancelled' })
  }

  /** A session or conversation went away: every request of it stops waiting. */
  function detachGroup(group: string): void {
    for (const record of [...records.values()]) {
      if (record.group === group) finish(record, { status: 'cancelled' })
    }
  }

  function settle(download: ModelDownload, outcome: ModelDownloadOutcome): void {
    const index = downloads.indexOf(download)
    if (index === -1) return
    downloads.splice(index, 1)
    const wasRunning = download.status === 'downloading'
    controllers.get(download.id)?.abort()
    controllers.delete(download.id)
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
    for (const id of download.waiters) {
      const record = records.get(id)
      if (!record) continue
      record.downloads.delete(download.id)
      if (outcome.status !== 'done') finish(record, outcome)
      else finishIfDone(record)
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
      settle(download, { status: 'failed', error: new Error('No model downloader is available') })
      return
    }
    download.status = 'downloading'
    for (const listener of listeners.get(download.id) ?? []) listener.onStart?.()
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

  function groupWaits(download: ModelDownload, group: string): boolean {
    return download.waiters.some((id) => records.get(id)?.group === group)
  }

  /** What `group` is waiting on, reactively; null once it waits on nothing. */
  function snapshot(group: string): ModelDownloadWait | null {
    const mine = downloads.filter((download) => groupWaits(download, group))
    if (mine.length === 0) return null
    const running = mine.find((download) => download.status === 'downloading')
    return {
      status: running ? 'downloading' : 'queued',
      models: mine.flatMap((download) => download.models),
      progress: running?.progress ?? null,
      downloadIds: mine.map((download) => download.id),
    }
  }

  return { downloads, split, waiter, cancel, detachGroup, watchDownload, snapshot }
}

let downloader: ModelDownloader | null = null
const startListeners = new Set<(label: string, waiterId: string) => void>()

export function registerModelDownloader(next: ModelDownloader | null): void {
  downloader = next
}

/** Hears every Model Download being queued, and the waiter whose yes queued it. */
export function onModelDownloadStart(listener: (label: string, waiterId: string) => void) {
  startListeners.add(listener)
  return () => startListeners.delete(listener)
}

function createShared() {
  return createModelDownloadQueue({
    downloader: () => downloader,
    onStart: (label, waiterId) => {
      for (const listener of startListeners) listener(label, waiterId)
    },
  })
}

let shared = createShared()

export function modelDownloads(): ModelDownloadQueue {
  return shared
}

export function resetModelDownloadsForTest(): void {
  shared = createShared()
}

/** A waiter's outcome as the caller of a download sees it: resolves on done, throws otherwise. */
export function throwUnlessDone(outcome: ModelDownloadOutcome, cancellation: () => unknown): void {
  if (outcome.status === 'done') return
  if (outcome.status === 'cancelled') throw cancellation()
  throw outcome.error
}
