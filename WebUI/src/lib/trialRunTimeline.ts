import { sessionTimelineItems } from '@/lib/sessionTimeline'
import type { PendingAudio, PendingMedia, RunProgress, SessionTimelineItem } from '@/lib/turnTypes'
import type { AgentRunTag, AgentTurnTag } from '@/types/sessionTimeline'

export type TrialRunView = {
  harnessSessionId: string
  presetName: string
  taskRun: AgentRunTag
  /** The Harness Session record's messages, which carry no timeline tag of their own. */
  saved: readonly { id: string }[]
  /** The runtime's messages while a Step is streaming. */
  live?: readonly { id: string }[]
  /** Set while the Trial Run is in flight, between Steps too. */
  progress?: RunProgress
}

/** A Trial Run as the timeline shows an Agent Run: one Turn. */
export function trialRunItems<
  M extends PendingMedia = PendingMedia,
  A extends PendingAudio = PendingAudio,
>(view: TrialRunView): SessionTimelineItem<M, A>[] {
  const tag: AgentTurnTag = {
    presetName: view.presetName,
    harnessSessionId: view.harnessSessionId,
    taskRun: view.taskRun,
  }
  const timeline = view.saved.map((message) => ({
    ...message,
    metadata: { ...(message as { metadata?: object }).metadata, agentTurn: tag },
  }))
  return sessionTimelineItems<M, A>(timeline, {
    agents: view.live ? [{ tag, messages: view.live, live: true }] : [],
    agentRunsInFlight: view.progress ? { [view.harnessSessionId]: view.progress } : {},
  })
}
