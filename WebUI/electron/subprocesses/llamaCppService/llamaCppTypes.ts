import { ChildProcess } from 'node:child_process'

/**
 * Represents a running llama-server process (either LLM or embedding)
 */
export interface LlamaServerProcess {
  process: ChildProcess
  port: number
  modelPath: string
  modelRepoId: string
  type: 'llm' | 'embedding'
  contextSize?: number
  isReady: boolean
}

/**
 * Configuration for LlamaCPP service paths
 */
export interface LlamaCppPaths {
  baseDir: string
  serviceDir: string
  llamaCppDir: string
  llamaCppExePath: string
  zipPath: string
}

/**
 * LlamaCPP version information
 */
export interface LlamaCppVersion {
  version: string
  releaseTag?: string
}

