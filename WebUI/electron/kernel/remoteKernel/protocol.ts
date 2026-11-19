export const REMOTE_PATH = '/aipg/remote/v1'
export const REMOTE_HEADER_TOKEN = 'x-aipg-remote-token'

/** The backend port ranges `apiServiceRegistry` allocates from (and their LLM sub-servers). */
export function isLoopbackServicePort(port: number): boolean {
  return Number.isInteger(port) && port >= 29000 && port <= 59999
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
}

export function mimeTypeFor(extension: string): string {
  return MIME_TYPES[extension.toLowerCase()] ?? 'application/octet-stream'
}

const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=[/?#]|$)/

/**
 * Loopback service URLs the workstation hands out point at the client's own machine
 * there, so the client rewrites them onto its local tunnel (`/svc/<port>`) and back.
 */
export function loopbackRewriter(tunnelPort: number): {
  inbound: (value: string) => string
  outbound: (value: string) => string
} {
  const tunnelPrefix = `http://127.0.0.1:${tunnelPort}/svc/`
  return {
    inbound: (value) => {
      const match = LOOPBACK_URL.exec(value)
      if (!match || !isLoopbackServicePort(Number(match[1]))) return value
      return `${tunnelPrefix}${match[1]}${value.slice(match[0].length)}`
    },
    outbound: (value) => {
      if (!value.startsWith(tunnelPrefix)) return value
      const rest = value.slice(tunnelPrefix.length)
      const port = /^\d+/.exec(rest)?.[0]
      return port ? `http://127.0.0.1:${port}${rest.slice(port.length)}` : value
    },
  }
}
