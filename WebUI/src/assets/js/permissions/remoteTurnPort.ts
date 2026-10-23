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
 * Why an open Channel Question stops being answerable in the channel: answered on the desktop,
 * the pause ended, or the channel it was asked on is no longer the Notification Channel.
 */
export type ChannelQuestionOutcome = 'answered-in-app' | 'closed' | 'unavailable'

/** An Agent Mode download asked on the Notification Channel (docs/adr/0004). */
export type DownloadChannelQuestion = {
  /** Resolves on a tap in the channel; never resolves when the channel cannot answer. */
  answer: Promise<boolean>
  /** Runs the download in the question's channel after a channel Confirm. */
  download: () => Promise<void>
  /** Takes the buttons away with a note; idempotent, and `answer` stays unresolved. */
  retire: (outcome: ChannelQuestionOutcome) => void
}

export type RemoteTurnPort = {
  isActive: () => boolean
  downloadModels: (
    models: DownloadModelParam[],
    options?: { skipConfirmation?: boolean },
  ) => Promise<void>
  /** Home Agent on, a Notification Channel set and automatic Notifications on. */
  canAskChannelQuestion: () => boolean
  askDownloadQuestion: (
    models: DownloadModelParam[],
    context: { label: string; conversationKey: string },
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
    download: async () => {
      throw new Error('No Notification Channel to download through')
    },
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
