export type RemoteKernelMode = 'off' | 'host' | 'client'

export type RemoteKernelConnection = 'off' | 'connecting' | 'connected' | 'disconnected'

export type RemoteKernelStatus = {
  /** The mode this launch runs in; a saved change applies on the next start. */
  activeMode: RemoteKernelMode
  configuredMode: RemoteKernelMode
  hostPort: number
  hostToken: string
  /** This machine's LAN IPv4 addresses, for the client to type in. */
  hostAddresses: string[]
  hostPeers: number
  clientHost: string
  clientPort: number
  clientHasToken: boolean
  connection: RemoteKernelConnection
  remoteHostname?: string
  lastError?: string
}

export type RemoteKernelConfigUpdate = {
  mode: RemoteKernelMode
  hostPort?: number
  clientHost?: string
  clientPort?: number
  /** Omitted keeps the stored token. */
  clientToken?: string
}

export type RemoteKernelTarget = { host: string; port: number; token: string }

export const REMOTE_KERNEL_DEFAULT_PORT = 47800
