import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  ChannelArgs,
  ChannelResult,
  InvokeChannelName,
  IpcFail,
  PushChannelName,
  PushPayload,
  SendChannelName,
} from '@/types/ipcChannels'
import { deliverPush, noteDriver } from './rendererSinks'
import {
  isDriverChannel,
  recordInvokeHandler,
  recordSendHandler,
  remoteInvokeForwarder,
  remoteSendForwarder,
} from './remoteKernel/dispatch'

export type InvokeHandler<N extends InvokeChannelName> = (
  event: IpcMainInvokeEvent,
  ...args: ChannelArgs<N>
) => ChannelResult<N> | Promise<ChannelResult<N>>

export function typedHandle<N extends InvokeChannelName>(
  channel: N,
  handler: InvokeHandler<N>,
): void {
  recordInvokeHandler(channel, handler as never)
  const forward = remoteInvokeForwarder(channel)
  if (forward) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => forward(args))
    return
  }
  if (isDriverChannel(channel)) {
    ipcMain.handle(channel, ((event: IpcMainInvokeEvent, ...args: ChannelArgs<N>) => {
      noteDriver('window')
      return handler(event, ...args)
    }) as never)
    return
  }
  ipcMain.handle(channel, handler as never)
}

export type SendHandler<N extends SendChannelName> = (
  event: IpcMainEvent,
  ...args: ChannelArgs<N>
) => void

export function typedOn<N extends SendChannelName>(channel: N, listener: SendHandler<N>): void {
  recordSendHandler(channel, listener as never)
  const forward = remoteSendForwarder(channel)
  if (forward) {
    ipcMain.on(channel, (_event, ...args: unknown[]) => forward(args))
    return
  }
  ipcMain.on(channel, listener as never)
}

export function typedSend<N extends PushChannelName>(
  sender: WebContents,
  channel: N,
  payload: PushPayload<N>,
): void {
  deliverPush(sender, channel, payload)
}

export const ipcErrorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const ipcFail = (e: unknown): IpcFail => ({ success: false, error: ipcErrorText(e) })
