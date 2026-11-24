export type RemoteKernelMode = 'off' | 'host' | 'client'

export type RemoteKernelConnection = 'off' | 'connecting' | 'connected' | 'disconnected'

export type PairingWindowInfo = { code: string; expiresAt: number; attemptsLeft: number }

export type PairedDeviceInfo = { id: string; name: string; pairedAt: number; lastSeenAt?: number }

/** The workstation a thin client paired with; its certificate is pinned. */
export type PairedHostInfo = { host: string; port: number; hostname: string; fingerprint: string }

export type DiscoveredHost = {
  name: string
  hostname: string
  addresses: string[]
  port: number
  /** First 16 hex digits of the advertised certificate fingerprint: a hint, not trust. */
  fingerprintHint: string
  pairingOpen: boolean
}

export type RemoteKernelStatus = {
  /** The mode this launch runs in; a saved change applies on the next start. */
  activeMode: RemoteKernelMode
  configuredMode: RemoteKernelMode
  hostPort: number
  /** This machine's LAN IPv4 addresses, for typing into a client by hand. */
  hostAddresses: string[]
  hostFingerprint?: string
  hostPeers: number
  pairing: PairingWindowInfo | null
  devices: PairedDeviceInfo[]
  pairedHost: PairedHostInfo | null
  connection: RemoteKernelConnection
  remoteHostname?: string
  lastError?: string
}

export type RemoteKernelConfigUpdate = { mode: RemoteKernelMode; hostPort?: number }

export type RemoteKernelPairRequest = { host: string; port: number; code: string }

export const REMOTE_KERNEL_DEFAULT_PORT = 47800
