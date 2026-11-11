import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import type { ChannelAdapter } from './adapter'
import type { InboundChannelMessage } from './answerRouter'
import type { InboundMeta } from './types'

/** One inbound command as its handler sees it; `args` is the text after the command. */
export type ChannelCommandContext = {
  adapter: ChannelAdapter
  msg: InboundChannelMessage
  meta?: InboundMeta
  args: string
}

/**
 * A router-owned slash command. Every command also needs its Python, Slack manifest and LAN
 * chat menu entries (AGENTS.md, "Home Agent Slash Commands").
 */
export type ChannelCommand = {
  /** Lowercase, without the slash. */
  name: string
  /** How `/help` shows it, e.g. `/load <n>`. */
  usage: string
  describe: (copy: AnswerRouterCopy) => string
  run: (context: ChannelCommandContext) => Promise<void>
}

/** A button the router itself sent; its callback data is `<prefix><value>`. */
export type ChannelCallback = {
  prefix: string
  run: (context: Omit<ChannelCommandContext, 'args'>, value: string) => Promise<void>
}

const COMMAND = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i

/** `/load 2` → `{ name: 'load', args: '2' }`; null for text that is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = COMMAND.exec(text.trim())
  if (!match) return null
  return { name: match[1], args: (match[2] ?? '').trim() }
}

/** The `/help` text: each command, then where plain messages and Answers go. */
export function helpText(
  commands: readonly ChannelCommand[],
  copy: AnswerRouterCopy,
  answering: string | null,
): string {
  const lines = commands.map((command) => `\`${command.usage}\` — ${command.describe(copy)}`)
  return [`**${copy.helpTitle}**`, ...lines, '', copy.helpPlain, ...(answering ? [answering] : [])]
    .join('\n')
    .trim()
}
