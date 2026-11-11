import type { ChannelKind } from '@/assets/js/store/channels/types'

export type TypingPulse = (kind: ChannelKind, state: 'start' | 'stop') => void

export type ChannelTyping = {
  start: (turnId: string, kind: ChannelKind) => void
  stop: (turnId: string) => void
  stopAll: () => void
}

/** "typing…" per Channel, counted per turn: it stops when the Channel's last turn stops. */
export function createChannelTyping(pulse: TypingPulse, repeatMs: number): ChannelTyping {
  const turns = new Map<string, ChannelKind>()
  const heartbeats = new Map<ChannelKind, NodeJS.Timeout>()

  function stop(turnId: string): void {
    const kind = turns.get(turnId)
    if (!kind) return
    turns.delete(turnId)
    if ([...turns.values()].includes(kind)) return
    clearInterval(heartbeats.get(kind))
    heartbeats.delete(kind)
    pulse(kind, 'stop')
  }

  return {
    start: (turnId, kind) => {
      if (turns.has(turnId)) return
      turns.set(turnId, kind)
      if (heartbeats.has(kind)) return
      pulse(kind, 'start')
      heartbeats.set(
        kind,
        setInterval(() => pulse(kind, 'start'), repeatMs),
      )
    },
    stop,
    stopAll: () => {
      for (const turnId of [...turns.keys()]) stop(turnId)
    },
  }
}
