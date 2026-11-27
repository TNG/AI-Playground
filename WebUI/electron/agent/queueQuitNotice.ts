import type { ChannelKind } from '@/assets/js/store/channels/types'
import { fillTemplate } from '@/lib/fillTemplate'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

const DEFAULT_TIMEOUT_MS = 3000

/** Tells each Channel that is still on how many of its queued messages the quit drops. */
export async function tellDroppedQueues(args: {
  queued: Extract<InFlightWorkItem, { kind: 'channel-queue' }>[]
  channels: readonly ChannelKind[]
  template: string
  send: (kind: ChannelKind, text: string) => Promise<unknown>
  timeoutMs?: number
}): Promise<void> {
  const sends = args.queued
    .filter((item) => args.channels.includes(item.channel) && item.state.count > 0)
    .map((item) =>
      args.send(item.channel, fillTemplate(args.template, { count: item.state.count })),
    )
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
  try {
    await Promise.race([Promise.allSettled(sends), deadline])
  } finally {
    clearTimeout(timer)
  }
}
