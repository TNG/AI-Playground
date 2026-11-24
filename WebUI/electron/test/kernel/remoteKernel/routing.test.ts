import { describe, expect, it } from 'vitest'
import { CHANNELS, type InvokeChannelName } from '@/types/ipcChannels'
import {
  DRIVER_CHANNELS,
  INVOKE_ROUTES,
  PUSH_ROUTES,
  SEND_ROUTES,
  ipcRoute,
  type IpcRoute,
} from '@/types/ipcRouting'

const rows = Object.entries(CHANNELS) as [string, { kind: string }][]
const names = (kind: string) =>
  rows
    .filter(([, row]) => row.kind === kind)
    .map(([name]) => name)
    .sort()

describe('remote-kernel routing table', () => {
  it('classifies every manifest row exactly once, under its own kind', () => {
    expect(Object.keys(INVOKE_ROUTES).sort()).toEqual(names('invoke'))
    expect(Object.keys(SEND_ROUTES).sort()).toEqual(names('send'))
    expect(Object.keys(PUSH_ROUTES).sort()).toEqual(names('push'))
  })

  it('refuses a table that leaves a row out', () => {
    // @ts-expect-error a missing row is a build error, the same discipline as the registries
    const partial: Record<InvokeChannelName, IpcRoute> = { 'kernel:getSnapshot': 'remote' }
    expect(partial).toBeDefined()
  })

  it('keeps the handlers that need the calling window on the client', () => {
    for (const channel of [
      'showOpenDialog',
      'showMessageBox',
      'setWinSize',
      'zoomIn',
      'saveMediaCopy',
      'ondragstart',
      'saveImage',
      'agentMode:mediaFileAction',
      'cameraCapture:registerShortcut',
      'lifecycle:bridgeReady',
      'lifecycle:restart',
    ]) {
      expect(ipcRoute(channel), channel).toBe('local')
    }
  })

  it('serves the kernel, chat, agent, media and session stores from the workstation', () => {
    for (const channel of [
      'kernel:getSnapshot',
      'chat:submitTurn',
      'chat:answer',
      'agentMode:startTurn',
      'agentMode:toolResult',
      'agentMode:importAttachment',
      'artifact:run',
      'artifact:respond',
      'permissions:respond',
      'conversations:save',
      'sessions:list',
      'mediaItems:bootstrap',
      'preferences:write',
      'getServices',
      'ensureBackendReadiness',
      'saveImageToMediaInput',
    ]) {
      expect(ipcRoute(channel), channel).toBe('remote')
    }
  })

  it('never forwards the remote-kernel settings themselves', () => {
    for (const channel of Object.keys(INVOKE_ROUTES).filter((n) => n.startsWith('remoteKernel:'))) {
      expect(ipcRoute(channel), channel).toBe('local')
    }
  })

  it('sends work-executing pushes to one renderer and prompts to all', () => {
    expect(PUSH_ROUTES['agentMode:executeTool']).toBe('driver')
    expect(PUSH_ROUTES['chat:ask']).toBe('driver')
    expect(PUSH_ROUTES['artifact:request']).toBe('driver')
    expect(PUSH_ROUTES['permissions:prompt']).toBe('broadcast')
    expect(PUSH_ROUTES['lifecycle:askClose']).toBe('local')
  })

  it('only lets remote calls make a renderer the driver', () => {
    for (const channel of DRIVER_CHANNELS) expect(ipcRoute(channel), channel).toBe('remote')
  })
})
