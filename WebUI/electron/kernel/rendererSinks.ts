import type { WebContents } from 'electron'
import { pushRoute } from '@/types/ipcRouting'

/** A remote-kernel client's renderer, reached over its event stream. */
export type RemotePeer = {
  id: string
  push: (channel: string, payload: unknown) => void
}

export type RendererActor = 'window' | string

const peers = new Map<string, RemotePeer>()
let driver: RendererActor = 'window'

export function addRemotePeer(peer: RemotePeer): () => void {
  peers.set(peer.id, peer)
  return () => {
    if (peers.get(peer.id) !== peer) return
    peers.delete(peer.id)
    if (driver === peer.id) driver = 'window'
  }
}

export function remotePeerCount(): number {
  return peers.size
}

/** The renderer that last started a turn or run receives the pushes that execute work. */
export function noteDriver(actor: RendererActor): void {
  driver = actor
}

export function currentDriver(): RendererActor {
  return driver
}

/** Deliver a push to this app's window and, per its route, to connected remote renderers. */
export function deliverPush(sender: WebContents, channel: string, payload: unknown): void {
  const route = pushRoute(channel)
  if (peers.size === 0 || route === 'local') {
    sender.send(channel, payload)
    return
  }
  if (route === 'driver') {
    const peer = driver === 'window' ? undefined : peers.get(driver)
    if (peer) peer.push(channel, payload)
    else sender.send(channel, payload)
    return
  }
  if (!sender.isDestroyed()) sender.send(channel, payload)
  for (const peer of peers.values()) peer.push(channel, payload)
}

export function resetRendererSinksForTest(): void {
  peers.clear()
  driver = 'window'
}
