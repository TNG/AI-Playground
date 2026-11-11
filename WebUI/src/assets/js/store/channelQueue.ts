import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { QueuedChannelMessage } from '@/assets/js/store/channels/channelQueue'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

/**
 * What the Channels' router has queued, per Session, as the desktop shows it. Memory only:
 * the queue itself lives in the router and never survives a restart (ADR 0002).
 */
export const useChannelQueue = defineStore('channelQueue', () => {
  const queued = ref<Record<string, QueuedChannelMessage[]>>({})

  function publish(sessionRef: string, messages: QueuedChannelMessage[]): void {
    const { [sessionRef]: _previous, ...rest } = queued.value
    queued.value = messages.length > 0 ? { ...rest, [sessionRef]: messages } : rest
  }

  function queuedIn(sessionRef: string | null): QueuedChannelMessage[] {
    return sessionRef ? (queued.value[sessionRef] ?? []) : []
  }

  /** One item per Channel with queued messages, for the close question. */
  const inFlightWork = computed<InFlightWorkItem[]>(() => {
    const counts = new Map<ChannelKind, number>()
    for (const message of Object.values(queued.value).flat()) {
      counts.set(message.channel, (counts.get(message.channel) ?? 0) + 1)
    }
    return [...counts].map(([channel, count]) => ({
      kind: 'channel-queue',
      channel,
      state: { status: 'queued', count },
    }))
  })

  return { queued, publish, queuedIn, inFlightWork }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChannelQueue, import.meta.hot))
}
