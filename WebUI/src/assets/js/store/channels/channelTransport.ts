import type { ChannelArgs, ChannelResult } from '@/types/ipcChannels'
import type { ChannelKind } from './types'

export type ChannelSendAction = ChannelArgs<'channel:send'>[1]
export type ChannelSendResult = ChannelResult<'channel:send'>
export type ChannelSend = (
  kind: ChannelKind,
  action: ChannelSendAction,
  payload: Record<string, unknown>,
) => Promise<ChannelSendResult>

// The adapters run in main (the Channels dispatcher) and in the window (download and speech
// messages); main installs its own transport, the window keeps the IPC bridge.
let transport: ChannelSend = (kind, action, payload) =>
  window.electronAPI.channels.send(kind, action, payload)

export function setChannelTransport(send: ChannelSend): void {
  transport = send
}

export function channelSend(
  kind: ChannelKind,
  action: ChannelSendAction,
  payload: Record<string, unknown>,
): Promise<ChannelSendResult> {
  return transport(kind, action, payload)
}
