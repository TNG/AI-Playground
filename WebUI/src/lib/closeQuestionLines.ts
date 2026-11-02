import { fillTemplate } from './fillTemplate'
import type { CloseQuestion, InFlightWorkItem } from '@/types/lifecycleIpc'

type Strings = Record<string, string>

function itemLabel(item: InFlightWorkItem, t: Strings): string {
  const named = (name: string | undefined, namedKey: string, unnamedKey: string) =>
    name ? fillTemplate(t[namedKey], { name }) : t[unnamedKey]
  switch (item.kind) {
    case 'agent-turn':
    case 'prompt-run':
      return named(item.name, 'CLOSE_ITEM_AGENT', 'CLOSE_ITEM_AGENT_UNNAMED')
    case 'chat-turn':
      return named(item.name, 'CLOSE_ITEM_CHAT', 'CLOSE_ITEM_CHAT_UNNAMED')
    case 'home-agent-turn':
      return t.CLOSE_ITEM_HOME_AGENT
    case 'media-run':
      return item.mode === 'video'
        ? t.CLOSE_ITEM_VIDEO
        : item.mode === 'imageEdit'
          ? t.CLOSE_ITEM_IMAGE_EDIT
          : t.CLOSE_ITEM_IMAGE_GEN
    case 'task-run':
      return named(item.name, 'CLOSE_ITEM_TASK', 'CLOSE_ITEM_AGENT_UNNAMED')
  }
}

function stateLabel(item: InFlightWorkItem, t: Strings): string {
  switch (item.state.status) {
    case 'running':
      return t.CLOSE_STATE_RUNNING
    case 'starting':
      return t.CLOSE_STATE_STARTING
    case 'paused':
      return t.CLOSE_STATE_PAUSED
    case 'queued':
      return item.state.count === undefined
        ? t.CLOSE_STATE_QUEUED
        : fillTemplate(t.CLOSE_STATE_QUEUED_COUNT, { count: item.state.count })
    case 'step':
      return fillTemplate(t.CLOSE_STATE_STEP, { index: item.state.index, count: item.state.count })
  }
}

/** The close dialog's lines: one per shown item, then the "and N more" remainder. */
export function closeQuestionLines(question: CloseQuestion, t: Strings): string[] {
  const lines = question.items.map((item) =>
    fillTemplate(t.CLOSE_ITEM_LINE, { item: itemLabel(item, t), state: stateLabel(item, t) }),
  )
  if (question.more > 0) lines.push(fillTemplate(t.CLOSE_MORE, { count: question.more }))
  return lines
}
