import { createAppError, createCancellation } from '@/assets/js/errors/appError'
import type { ModelDownloadProgress } from '@/lib/modelDownloader'
import type {
  ModelDownloadOutcome,
  ModelDownloadQueue,
} from '@/assets/js/models/modelDownloadQueue'
import type { ChannelAdapter } from './adapter'
import type { ChannelMessageRef, InboundMeta } from './types'

const EDIT_THROTTLE_MS = 3000

/** The channel lines of a download; the Home Agent chat path keeps the English defaults. */
export type HeadlessDownloadText = {
  progress: (p: { repoId: string; percent: number; completed: number; total: number }) => string
  complete: string
  failed: (message: string) => string
  cancelled: string
}

const ENGLISH_TEXT: HeadlessDownloadText = {
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
  meta?: InboundMeta,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
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
  queue: Pick<ModelDownloadQueue, 'watchDownload'>
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
  return tracked
}

function outcomeLine(outcome: ModelDownloadOutcome, text: HeadlessDownloadText): string {
  if (outcome.status === 'done') return text.complete
  if (outcome.status === 'cancelled') return text.cancelled
  return text.failed(outcome.detail?.message ?? outcome.error.message)
}

/**
 * A Home Agent chat turn's approved download: one Model Download in the shared
 * queue, followed by one channel message that is edited in place.
 */
export async function runHeadlessDownload(
  args: {
    adapter: ChannelAdapter
    meta?: InboundMeta
    list: DownloadModelParam[]
    waiter: string
    label: string
    text?: HeadlessDownloadText
  },
  deps: { queue: ModelDownloadQueue },
): Promise<void> {
  const { adapter, meta, list, waiter } = args
  const text = args.text ?? ENGLISH_TEXT
  const { queue } = deps
  const started = queue.start(list, [waiter], args.label)
  const downloadId = started ?? queue.downloadsOf(waiter)[0]?.id
  if (downloadId) {
    const first = queue.downloadsOf(waiter).find((d) => d.id === downloadId)
    const message = postDownloadMessage(
      adapter,
      text.progress({
        repoId: first?.models[0]?.repo_id ?? '',
        percent: 0,
        completed: 0,
        total: first?.models.length ?? list.length,
      }),
      meta,
    )
    trackModelDownload({ queue, downloadId, message, text })
  }
  const outcome = await queue.settled(waiter)
  if (outcome.status === 'done') return
  if (outcome.status === 'cancelled') {
    throw createCancellation({ technicalMessage: 'The model download was cancelled' })
  }
  throw createAppError({
    category: 'inference',
    code: 'model/download-failed',
    userMessage: 'The model download failed.',
    surface: 'silent',
    cause: outcome.error,
  })
}
