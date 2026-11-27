import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'

/** The user presets that were Agent Presets: chat presets linked to a saved Agent. */

const LOG_SCOPE = 'agent-preset-files'

export type AgentPresetFile = {
  file: string
  name: string
  agentId: string
  description?: string
  image?: string
}

export async function readAgentPresetFiles(dir: string): Promise<AgentPresetFile[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const presets: AgentPresetFile[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(dir, name)
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
      if (raw.type !== 'chat' || typeof raw.agentTaskId !== 'string') continue
      presets.push({
        file,
        name: String(raw.name ?? ''),
        agentId: raw.agentTaskId,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(typeof raw.image === 'string' ? { image: raw.image } : {}),
      })
    } catch {
      appLoggerInstance.warn(`unreadable preset skipped: ${name}`, LOG_SCOPE)
    }
  }
  return presets
}

export async function removeAgentPresetFile(preset: AgentPresetFile): Promise<void> {
  await fs.rm(preset.file, { force: true })
}
