import { followUpAgentName, sessionTimelineItems } from '@/lib/sessionTimeline'
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

/**
 * A Trial Run as a conversation: one Turn per Step, its prompt as sent, labelled with the Step,
 * then its Follow-ups as plain prompts.
 */
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
  const followUps = new Set(
    [...view.saved, ...(view.live ?? [])]
      .filter((message) => followUpAgentName(message) !== undefined)
      .map((message) => message.id),
  )
  let step = 0
  let lastStep: SessionTimelineItem<M, A> | undefined
  for (const item of items) {
    // A Trial Run is the Agent Library's, not a Session's: nothing of it can be deleted alone.
    if (item.kind === 'agent' && item.footer.harnessTurn) {
      const { harnessTurn: _turn, ...footer } = item.footer
      item.footer = { ...footer, actions: footer.actions.filter((action) => action !== 'delete') }
    }
    if (item.kind !== 'agent' || !item.prompt || followUps.has(item.id)) continue
    step++
    item.prompt = { ...item.prompt, step }
    lastStep = item
  }
  const end = view.taskRun.end
  const last = lastStep ?? items.at(-1)
  if (end && !view.progress && last?.kind === 'agent') {
    const state = end.kind === 'failed' ? 'failed' : 'cancelled'
    last.result = [
      ...last.result,
      { kind: 'failure', ...generationFailure({ state, error: end.message }) },
    ]
  }
  return items
}
