import type {
  ChannelHostInvokeName,
  ChannelHostSendName,
  InvokeHandlerMap,
  SendHandlerMap,
} from '../ipcRegistries'
import type { ChannelStateHost } from '../../channels/channelState'
import type { ChannelHost } from '../../channels/channelHost'
import type { WindowPort } from '../../channels/windowPort'

export type ChannelHostRegistryDeps = {
  state: ChannelStateHost
  host: ChannelHost
  windowPort: WindowPort
}

export function buildChannelHostRegistry(deps: ChannelHostRegistryDeps) {
  const { state, host } = deps
  return {
    'channelHost:getState': () => state.state(),
    'channelHost:setMaster': (_event, on) => state.setMaster(on),
    'channelHost:setEnabled': (_event, kind, on) => state.setEnabled(kind, on),
    'channelHost:setVerified': (_event, kind) => state.setVerified(kind),
    'channelHost:saveConfig': (_event, kind, config) => state.saveConfig(kind, config),
    'channelHost:clearConfig': (_event, kind) => state.clearConfig(kind),
    'channelHost:migrate': (_event, legacy) => state.migrate(legacy),
    'channelHost:setChannelSession': (_event, kind, sessionRef) =>
      host.setChannelSession(kind, sessionRef),
  } satisfies InvokeHandlerMap<ChannelHostInvokeName>
}

export function buildChannelHostSendRegistry(deps: ChannelHostRegistryDeps) {
  return {
    'channelHost:portAnswer': (_event, payload) => deps.windowPort.answer(payload),
    'channelHost:portState': (_event, state) => deps.windowPort.mirror(state),
  } satisfies SendHandlerMap<ChannelHostSendName>
}
