import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import type { QueuedChannelMessage } from '@/assets/js/store/channels/channelQueue'
import type { ChannelQueuesState } from '@/types/channelHostIpc'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'

/**
 * What the Channels' router has queued, per Session, as the desktop shows it. The router runs in
 * the kernel; this is its projection. Memory only: the queue never survives a restart (ADR 0002).
 */
export const useQueuedChannelMessages = defineStore('queuedChannelMessages', () => {
  const queued = ref<Record<string, QueuedChannelMessage[]>>({})
  /** Sessions whose next batch of queued messages the router is sending now. */
  const sending = ref<Record<string, true>>({})

  function apply(state: ChannelQueuesState | undefined): void {
    if (!state) return
    queued.value = { ...state.queued }
    sending.value = Object.fromEntries(state.sending.map((sessionRef) => [sessionRef, true]))
  }

  if (typeof window !== 'undefined' && window.electronAPI) {
    const projection = connectKernelEventStream(
      (event) => {
        if (event.type === 'channel-queues') apply(event.queues)
      },
      (snapshot) => apply(snapshot.state.channelQueues),
    )
    projection.ready.catch(() => {})
    if (import.meta.hot) import.meta.hot.dispose(() => projection.dispose())
  }

  function publish(sessionRef: string, messages: QueuedChannelMessage[]): void {
    const { [sessionRef]: _previous, ...rest } = queued.value
    queued.value = messages.length > 0 ? { ...rest, [sessionRef]: messages } : rest
  }

  function setSending(sessionRef: string, isSending: boolean): void {
    const { [sessionRef]: _previous, ...rest } = sending.value
    sending.value = isSending ? { ...rest, [sessionRef]: true } : rest
  }

  /** A prompt sent from the desktop waits behind the Session's queued Channel messages. */
  function holdsPrompts(sessionRef: string): boolean {
    return (queued.value[sessionRef]?.length ?? 0) > 0 || !!sending.value[sessionRef]
  }

  function queuedIn(sessionRef: string | null): QueuedChannelMessage[] {
    return sessionRef ? (queued.value[sessionRef] ?? []) : []
  }

  return { queued, sending, publish, setSending, holdsPrompts, queuedIn }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useQueuedChannelMessages, import.meta.hot))
}
