/** What an Agent Mode download Channel Question writes, in the app language. */
export type ChannelQuestionTemplates = {
  /** `{label}` */
  askOne: string
  /** `{label}`, `{count}` */
  askMany: string
  /** `{label}` */
  lookupFailed: string
  /** `{label}`, `{models}` */
  gated: string
  confirm: string
  cancel: string
  confirmed: string
  cancelled: string
  /** The download waits behind another one. */
  queued: string
  starting: string
  /** `{model}`, `{percent}`, `{completed}`, `{total}` */
  progress: string
  /** `{label}` */
  complete: string
  /** `{label}`, `{error}` */
  failed: string
  answeredInApp: string
  /** A desktop decline of a question also asked in the channel. */
  declinedInApp: string
  closed: string
  unavailable: string
  stale: string
  /** `{models}`: the part of a question another Model Download already covers. */
  alreadyDownloading: string
  /** `{label}`: the question was closed because a yes elsewhere covers it. */
  alreadyDownloadingFor: string
  cancelledInApp: string
  appClosed: string
  /** Who started a Model Download, for `{label}` above. */
  forChat: string
  forOther: string
  forHomeAgent: string
}

// Only reached before the window has pushed its locale (tests, a reload mid-boot).
const ENGLISH: ChannelQuestionTemplates = {
  askOne: '{label} needs to download a model before it can continue:',
  askMany: '{label} needs to download {count} models before it can continue:',
  lookupFailed: '⏸ {label} needs a model download. Open AI Playground to continue.',
  gated:
    "🔒 {label} needs {models}, which can't be downloaded remotely because access is gated. Open AI Playground on your computer to accept the license or set a Hugging Face token.",
  confirm: '✅ Confirm',
  cancel: '✖ Cancel',
  confirmed: '✅ Confirmed.',
  cancelled: '❌ Cancelled.',
  queued: '⏳ Queued — the download starts when the one ahead of it finishes.',
  starting: '⬇️ Starting the download…',
  progress: '⬇️ Downloading `{model}` — {percent}% ({completed}/{total} models)',
  complete: '✅ Download complete. {label} is continuing.',
  failed: '⚠️ The model download for {label} failed: {error}',
  answeredInApp: '✔ Answered in AI Playground.',
  declinedInApp: '✖ Declined in AI Playground.',
  closed: '⏹ No longer needed — the session stopped waiting for this download.',
  unavailable: '⏹ No longer answerable here — answer it in AI Playground.',
  stale: 'This question is no longer open. Use AI Playground on your computer.',
  alreadyDownloading: 'Already downloading: {models}',
  alreadyDownloadingFor: '⏩ Already downloading for {label}.',
  cancelledInApp: '⏹ Download cancelled in AI Playground.',
  appClosed: '⏹ Stopped — AI Playground closed.',
  forChat: 'a Chat conversation',
  forOther: 'another task in AI Playground',
  forHomeAgent: 'the Home Agent',
}

let provider: (() => ChannelQuestionTemplates) | null = null

export function registerChannelQuestionTemplates(
  next: (() => ChannelQuestionTemplates) | null,
): void {
  provider = next
}

export function channelQuestionTemplates(): ChannelQuestionTemplates {
  const templates = provider?.()
  if (!templates) return ENGLISH
  const filled = { ...templates }
  for (const key of Object.keys(ENGLISH) as (keyof ChannelQuestionTemplates)[]) {
    if (!filled[key]) filled[key] = ENGLISH[key]
  }
  return filled
}
