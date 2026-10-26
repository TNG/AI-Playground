/**
 * The thin remote-turn port (architecture-target §8.2 leftover, step 13).
 *
 * Permissions must not instantiate the Home Agent store: that store is the
 * rest of the renderer graph, and a consent prompt that reaches through it
 * cannot move into main. Home Agent registers `{ isActive, downloadModels }`
 * at store setup; callers that never register get a desktop-only fallback
 * (no remote turn is active).
 */

/**
 * Why an open Channel Question stops being answerable in the channel: answered or
 * declined on the desktop, the pause ended, the channel it was asked on is no
 * longer the Notification Channel, or a yes elsewhere already downloads it all.
 */
export type ChannelQuestionOutcome =
  | 'answered-in-app'
  | 'declined-in-app'
  | 'closed'
  | 'unavailable'
  | { alreadyDownloadingFor: string }

/** An Agent Mode download asked on the Notification Channel (docs/adr/0004, 0005). */
export type DownloadChannelQuestion = {
  /** Resolves on a tap in the channel; never resolves when the channel cannot answer. */
  answer: Promise<boolean>
  /**
   * Edits the question's message into one Model Download's progress and outcome.
   * `answeredInApp` keeps that note above it, for a yes given on the desktop.
   */
  follow: (downloadId: string, options?: { answeredInApp?: boolean }) => void
  /** Takes the buttons away with a note; idempotent, and `answer` stays unresolved. */
  retire: (outcome: ChannelQuestionOutcome) => void
}

export type RemoteTurnPort = {
  isActive: () => boolean
  downloadModels: (
    models: DownloadModelParam[],
    options?: { skipConfirmation?: boolean; signal?: AbortSignal },
  ) => Promise<void>
  /** Home Agent on, a Notification Channel set and automatic Notifications on. */
  canAskChannelQuestion: () => boolean
  askDownloadQuestion: (
    models: DownloadModelParam[],
    context: {
      label: string
      conversationKey: string
      /** Named in the question as already downloading; it asks only about `models`. */
      alreadyDownloading?: DownloadModelParam[]
    },
  ) => DownloadChannelQuestion
}

const idlePort: RemoteTurnPort = {
  isActive: () => false,
  downloadModels: async () => {
    throw new Error('No remote turn is active for an in-channel download')
  },
  canAskChannelQuestion: () => false,
  askDownloadQuestion: () => ({
    answer: new Promise<boolean>(() => {}),
    follow: () => {},
    retire: () => {},
  }),
}

let registered: RemoteTurnPort | null = null

export function registerRemoteTurnPort(port: RemoteTurnPort | null): void {
  registered = port
}

export function remoteTurnPort(): RemoteTurnPort {
  return registered ?? idlePort
}
