import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type {
  ChannelArgs,
  ChannelResult,
  InvokeChannelName,
  SendChannelName,
} from '@/types/ipcChannels'

export function typedHandle<N extends InvokeChannelName>(
  channel: N,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: ChannelArgs<N>
  ) => ChannelResult<N> | Promise<ChannelResult<N>>,
): void {
  ipcMain.handle(channel, handler as never)
}

export function typedOn<N extends SendChannelName>(
  channel: N,
  listener: (event: IpcMainEvent, ...args: ChannelArgs<N>) => void,
): void {
  ipcMain.on(channel, listener as never)
}

export const ipcErrorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
