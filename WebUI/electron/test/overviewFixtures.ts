import fs from 'node:fs/promises'
import path from 'node:path'
import type { CapabilityHost } from '../agent/capabilities/types'
import { createSession, mutateSession, setSessionIncludedInOverviews } from '../session/sessions'
import { writeHistoryLines } from '../persist/sessionFiles'
import type { HistoryEntry } from '@/types/sessionIpc'
import type { OverviewChrome } from '@/types/overviewChrome'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export const NOW = new Date(2026, 10, 24, 15, 30).getTime()
export const TODAY = new Date(2026, 10, 24).getTime()

export type Tool = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

let entryCounter = 0

export function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  entryCounter += 1
  return {
    id: `entry-${entryCounter}`,
    timestamp: NOW - HOUR,
    preset: 'Assistant',
    kind: 'chat',
    prompt: `prompt ${entryCounter}`,
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

export type SeedSessionOptions = {
  included?: boolean
  updatedAt?: number
  timeline?: unknown[]
  harnessWorkspaces?: Record<string, string>
}

export async function seedSession(
  entries: HistoryEntry[],
  options: SeedSessionOptions = {},
): Promise<string> {
  const { id } = await createSession()
  await writeHistoryLines(
    id,
    entries.map((entry) => JSON.stringify(entry)),
  )
  const newest = entries.reduce(
    (max, entry) => Math.max(max, entry.timestamp),
    options.updatedAt ?? NOW,
  )
  await mutateSession(id, (file) => ({
    ...file,
    updatedAt: newest,
    ...(options.timeline ? { timeline: options.timeline } : {}),
    ...(options.harnessWorkspaces ? { harnessWorkspaces: options.harnessWorkspaces } : {}),
  }))
  await setSessionIncludedInOverviews(id, options.included ?? true)
  return id
}

export async function writeFile(hostPath: string, bytes = 'bytes'): Promise<void> {
  await fs.mkdir(path.dirname(hostPath), { recursive: true })
  await fs.writeFile(hostPath, bytes)
}

export function hostFor(options: {
  workspaceDir: string
  agentDir?: string
  /** `null` leaves the reporting Session out of the host, as a Trial Run would. */
  sessionRef?: string | null
  overviewChrome?: OverviewChrome
  responseLocale?: string
}): CapabilityHost {
  const sessionRef = options.sessionRef === undefined ? 'reporting-session' : options.sessionRef
  return {
    sessionId: 'harness-1',
    ...(sessionRef ? { sessionRef } : {}),
    workspaceDir: options.workspaceDir,
    agentDir: options.agentDir ?? options.workspaceDir,
    toolSpecs: [],
    keepModelsLoaded: false,
    ...(options.overviewChrome ? { overviewChrome: options.overviewChrome } : {}),
    ...(options.responseLocale ? { responseLocale: options.responseLocale } : {}),
  }
}

export function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? [])
    .map((part) => part.text)
    .join('\n')
}

export function toolNamed(tools: readonly { name: string }[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`${name} is missing`)
  return tool as unknown as Tool
}

export async function write(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(textOf(await tool.execute('call-1', params)))
}
