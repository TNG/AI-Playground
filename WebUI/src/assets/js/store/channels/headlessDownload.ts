import { createAppError, createCancellation } from '@/assets/js/errors/appError'
import type { ModelDownloadProgress } from '@/lib/modelDownloader'
import {
  throwUnlessDone,
  type ModelDownloadOutcome,
  type ModelDownloadQueue,
  type ModelDownloadWaiter,
} from '@/assets/js/models/modelDownloadQueue'
import type { ChannelAdapter } from './adapter'
import type { ChannelMessageRef, InboundMeta } from './types'

const EDIT_THROTTLE_MS = 3000

/** The channel lines of a download; the Home Agent chat path keeps the English defaults. */
export type HeadlessDownloadText = {
  /** Another Model Download runs first; a bare "Confirmed" would read as finished. */
  queued: string
  starting: string
  progress: (p: { repoId: string; percent: number; completed: number; total: number }) => string
  complete: string
  failed: (message: string) => string
  cancelled: string
}

const ENGLISH_TEXT: HeadlessDownloadText = {
  queued: '⏳ Queued — the download starts when the one ahead of it finishes.',
  starting: '⬇️ Starting the download…',
  progress: (p) =>
    `⬇️ Downloading \`${p.repoId}\` — ${p.percent}% (${p.completed}/${p.total} models)`,
  complete: '✅ Download complete.',
  failed: (message) => `⚠️ The model download failed: ${message}`,
  cancelled: '⏹ Download cancelled in AI Playground.',
}

/** One channel message a download rewrites in place; never a draft, so replies are untouched. */
export type DownloadMessage = { edit: (markdown: string) => void }

/** Sends a standalone message whose later edits apply in order once it has a handle. */
export function postDownloadMessage(
  adapter: ChannelAdapter,
  markdown: string,
  meta: InboundMeta | undefined,
  log: (message: string, error: unknown) => void,
): DownloadMessage {
  let latest: string | null = null
  let chain: Promise<ChannelMessageRef | undefined> = adapter
    .post(adapter.formatMarkdown(markdown), meta)
    .then(
      (result) => result.ref,
      (e: unknown) => {
        log('headlessDownload: post failed:', e)
        return undefined
      },
    )
  return {
    edit: (next) => {
      latest = next
      chain = chain.then(async (ref) => {
        if (!ref || latest !== next) return ref
        await adapter
          .editKeyboardMessage(ref, adapter.formatMarkdown(next), meta)
          .catch((e: unknown) => log('headlessDownload: edit failed:', e))
        return ref
      })
    },
  }
}

export type TrackedDownloadMessage = {
  /** Ends tracking with a last line (the app is closing); no-op once the download settled. */
  close: (note: string) => void
}

const openMessages = new Set<TrackedDownloadMessage>()

/** Every channel message still following a download ends with `note` (on quit). */
export function closeDownloadMessages(note: string): void {
  for (const message of [...openMessages]) message.close(note)
}

/** Keeps `message` on one Model Download: throttled progress, then its outcome. */
export function trackModelDownload(args: {
  queue: Pick<ModelDownloadQueue, 'watchDownload' | 'downloads'>
  downloadId: string
  message: DownloadMessage
  text: HeadlessDownloadText
  /** Lines kept above the progress, e.g. "Answered in AI Playground". */
  prefix?: string
}): TrackedDownloadMessage {
  const { message, text } = args
  const withPrefix = (line: string) => (args.prefix ? `${args.prefix}\n${line}` : line)
  let lastEdit = 0
  let done = false
  const tracked: TrackedDownloadMessage = {
    close: (note) => {
      if (done) return
      finish()
      message.edit(withPrefix(note))
    },
  }
  const finish = () => {
    done = true
    stop()
    openMessages.delete(tracked)
  }
  const stop = args.queue.watchDownload(args.downloadId, {
    onStart: () => {
      if (!done) message.edit(withPrefix(text.starting))
    },
    onProgress: (p: ModelDownloadProgress) => {
      const now = Date.now()
      if (p.speed === undefined || now - lastEdit < EDIT_THROTTLE_MS) return
      lastEdit = now
      message.edit(withPrefix(text.progress(p)))
    },
    onSettled: (outcome: ModelDownloadOutcome) => {
      if (done) return
      finish()
      message.edit(withPrefix(outcomeLine(outcome, text)))
    },
  })
  openMessages.add(tracked)
  const download = args.queue.downloads.find((d) => d.id === args.downloadId)
  if (download) message.edit(withPrefix(download.status === 'queued' ? text.queued : text.starting))
  return tracked
}

function outcomeLine(outcome: ModelDownloadOutcome, text: HeadlessDownloadText): string {
  if (outcome.status === 'done') return text.complete
  if (outcome.status === 'cancelled') return text.cancelled
  return text.failed(outcome.detail?.message ?? outcome.error.message)
}

/**
 * A Home Agent chat turn's approved download: one Model Download in the shared
 * queue, followed by one channel message that is edited in place. A turn that only
 * joined Model Downloads already running posts nothing.
 */
export async function runHeadlessDownload(
  args: {
    adapter: ChannelAdapter
    meta?: InboundMeta
    list: DownloadModelParam[]
    waiter: ModelDownloadWaiter
    label: string
    text?: HeadlessDownloadText
  },
  deps: {
    queue: Pick<ModelDownloadQueue, 'watchDownload' | 'downloads'>
    log: (message: string, error: unknown) => void
  },
): Promise<void> {
  const { adapter, meta, list, waiter } = args
  const text = args.text ?? ENGLISH_TEXT
  const started = list.length > 0 ? waiter.start(list, args.label) : null
  waiter.release()
  const download = started ? waiter.downloads().find((d) => d.id === started) : undefined
  if (download) {
    const first = download.status === 'queued' ? text.queued : text.starting
    const message = postDownloadMessage(adapter, first, meta, deps.log)
    trackModelDownload({ queue: deps.queue, downloadId: download.id, message, text })
  }
  const outcome = await waiter.settled
  if (outcome.status === 'failed') {
    throw createAppError({
      category: 'inference',
      code: 'model/download-failed',
      userMessage: 'The model download failed.',
      surface: 'silent',
      cause: outcome.error,
    })
  }
  throwUnlessDone(outcome, () =>
    createCancellation({ technicalMessage: 'The model download was cancelled' }),
  )
}
