import type { SessionPort } from './answerRouter'

// The window's composition file registers here because the Channels store cannot import
// Agent Mode (import cycle).

let registered: SessionPort | null = null

export function registerSessionPort(port: SessionPort | null): void {
  registered = port
}

export function sessionPort(): SessionPort | null {
  return registered
}
