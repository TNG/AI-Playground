import { randomBytes } from 'node:crypto'
import type { HermesBackendService } from '../../adapters/backends/hermesBackendService.ts'
import { appShutdown } from '../../kernel/shutdown.ts'
import { startHermesLlmProxy, type HermesLlmProxy } from './hermesLlmProxy.ts'
import { startAipgMcpServer, type AipgMcpServer } from './aipgMcpServer.ts'

export type HermesIntegration = { proxy: HermesLlmProxy; mcp: AipgMcpServer }

let service: HermesBackendService | null = null
let integration: Promise<HermesIntegration> | null = null

const newKey = () => randomBytes(32).toString('hex')

/** Both loopback servers Hermes calls back into, started once per app run on first use. */
export function hermesIntegration(): Promise<HermesIntegration> {
  integration ??= (async () => {
    const [proxy, mcp] = await Promise.all([
      startHermesLlmProxy(newKey()),
      startAipgMcpServer(newKey()),
    ])
    appShutdown.register({
      name: 'hermes integration servers',
      run: async () => {
        await Promise.all([proxy.close(), mcp.close()])
      },
    })
    return { proxy, mcp }
  })()
  return integration
}

export function wireHermesService(next: HermesBackendService): void {
  service = next
  next.setIntegrationProvider(async () => {
    const { proxy, mcp } = await hermesIntegration()
    return { llm: { url: proxy.url, key: proxy.key }, mcp: { url: mcp.url, key: mcp.key } }
  })
}

export function hermesService(): HermesBackendService | null {
  return service
}
