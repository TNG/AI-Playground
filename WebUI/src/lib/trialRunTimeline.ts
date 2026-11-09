import { sessionTimelineItems } from '@/lib/sessionTimeline'
import { generationFailure } from '@/lib/turnArtifacts'
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

/** A Trial Run as a conversation: one Turn per Step, its prompt as sent, labelled with the Step. */
export function trialRunItems<
  M extends PendingMedia = PendingMedia,
  A extends PendingAudio = PendingAudio,
>(view: TrialRunView): SessionTimelineItem<M, A>[] {
  const tag: AgentTurnTag = { presetName: view.presetName, harnessSessionId: view.harnessSessionId }
  const timeline = view.saved.map((message) => ({
    ...message,
    metadata: { ...(message as { metadata?: object }).metadata, agentTurn: tag },
  }))
  const items = sessionTimelineItems<M, A>(timeline, {
    agents: view.live ? [{ tag, messages: view.live, live: true }] : [],
  })
  let step = 0
  for (const item of items) {
    if (item.kind !== 'agent' || !item.prompt) continue
    step++
    item.prompt = { ...item.prompt, step }
  }
  const end = view.taskRun.end
  const last = items.at(-1)
  if (end && !view.progress && last?.kind === 'agent') {
    const state = end.kind === 'failed' ? 'failed' : 'cancelled'
    last.result = [
      ...last.result,
      { kind: 'failure', ...generationFailure({ state, error: end.message }) },
    ]
  }
  return items
}
