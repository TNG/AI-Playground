import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { DRIVER_CHANNELS, ipcRoute } from '@/types/ipcRouting'
import { noteDriver } from '../rendererSinks'

type AnyInvokeHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown
type AnySendHandler = (event: IpcMainEvent, ...args: never[]) => void

/** Forwards a channel to the workstation when this app runs as a thin client. */
export type RemoteForwarder = {
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  send: (channel: string, args: unknown[]) => void
}

const invokeHandlers = new Map<string, AnyInvokeHandler>()
const sendHandlers = new Map<string, AnySendHandler>()
let forwarder: RemoteForwarder | null = null

/** Must be set before the registries register, so remote rows get forwarders instead. */
export function setRemoteForwarder(next: RemoteForwarder | null): void {
  forwarder = next
}

export function recordInvokeHandler(channel: string, handler: AnyInvokeHandler): void {
  invokeHandlers.set(channel, handler)
}

export function recordSendHandler(channel: string, handler: AnySendHandler): void {
  sendHandlers.set(channel, handler)
}

export function remoteInvokeForwarder(
  channel: string,
): ((args: unknown[]) => Promise<unknown>) | null {
  if (!forwarder || ipcRoute(channel) !== 'remote') return null
  const target = forwarder
  return (args) => target.invoke(channel, args)
}

export function remoteSendForwarder(channel: string): ((args: unknown[]) => void) | null {
  if (!forwarder || ipcRoute(channel) !== 'remote') return null
  const target = forwarder
  return (args) => target.send(channel, args)
}

export function isDriverChannel(channel: string): boolean {
  return DRIVER_CHANNELS.has(channel)
}

export type RemoteDispatchError = Error & { status: number }

function dispatchError(message: string, status: number): RemoteDispatchError {
  return Object.assign(new Error(message), { status })
}

export function dispatchErrorStatus(error: unknown): number {
  const status = (error as Partial<RemoteDispatchError> | null)?.status
  return typeof status === 'number' ? status : 500
}

/**
 * Run a remote peer's call through the handler the window's IPC uses. The event is
 * synthetic: its `sender` is this app's window, which is all the remote-routed handlers
 * read off it (window-exists guards); handlers that need the caller's window are `local`.
 */
export async function dispatchRemote(
  peerId: string,
  kind: 'invoke' | 'send',
  channel: string,
  args: unknown[],
  sender: unknown,
): Promise<unknown> {
  if (ipcRoute(channel) !== 'remote') {
    throw dispatchError(`Channel ${channel} is not served remotely`, 403)
  }
  const event = { sender, remotePeerId: peerId }
  if (isDriverChannel(channel)) noteDriver(peerId)
  if (kind === 'send') {
    const handler = sendHandlers.get(channel)
    if (!handler) throw dispatchError(`No handler for ${channel}`, 404)
    handler(event as unknown as IpcMainEvent, ...(args as never[]))
    return undefined
  }
  const handler = invokeHandlers.get(channel)
  if (!handler) throw dispatchError(`No handler for ${channel}`, 404)
  return await handler(event as unknown as IpcMainInvokeEvent, ...(args as never[]))
}

export function resetRemoteDispatchForTest(): void {
  invokeHandlers.clear()
  sendHandlers.clear()
  forwarder = null
}
