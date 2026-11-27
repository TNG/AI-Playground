import fs from 'node:fs'
import path from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-coding-agent'
import {
  mediaFilesDirOf,
  sendToolImage,
  textResult,
  trialMediaUrl,
  workspaceFileToDataUri,
} from '../piCustomTools.ts'
import { noteGeneratedMedia } from '../generatedMedia.ts'
import { recordJournalMedia } from '../workspaceJournal.ts'
import { freeName } from '../../persist/fileOps.ts'
import { isInGamesLibrary } from '../../session/sessionWorkspace.ts'
import { appLoggerInstance } from '../../observability/logger.ts'
import { sessionFolderMediaUrl } from '@/lib/comfyWorkflow'
import type { AgentMediaDetails, AgentMediaItem } from '@/types/agentMediaDetails'
import type { CapabilityHost } from './types.ts'

const logger = appLoggerInstance
const LOG_SOURCE = 'screenshotOutput'

// ── shared screenshot output ─────────────────────────────────────────────────
//
// What a saved screenshot becomes for the user — the streamed thumbnail under
// the tool call, the image Artifact card in a Session, the turn-media note
// outside games — shared by every capability that captures one so their output
// cannot drift.

/** A capture engine's report: the model-facing text and the saved file, if any. */
export type ScreenshotEngineResult = {
  text: string
  screenshotPath?: string
}

/** Where the Session serves a screenshot from; a trial gets a copy in its files folder. */
async function screenshotMediaUrl(
  host: CapabilityHost,
  relativePath: string,
): Promise<string | undefined> {
  const target = host.sessionMedia
  if (!target) return undefined
  const apart = mediaFilesDirOf(target)
  if (!apart) {
    return target.workspace === 'trial'
      ? trialMediaUrl(target.agentId, `files/${relativePath}`)
      : sessionFolderMediaUrl(target.sessionRef, target.folderId, relativePath)
  }
  const filesDir = await apart()
  fs.mkdirSync(filesDir, { recursive: true })
  const served = await freeName(filesDir, path.basename(relativePath))
  fs.copyFileSync(path.join(host.workspaceDir, relativePath), path.join(filesDir, served))
  // The copy is apart from the turn's workspace, so a restore only finds it
  // through the journal's media notes.
  recordJournalMedia(host.sessionId, [path.join(filesDir, served)])
  return target.workspace === 'trial'
    ? trialMediaUrl(target.agentId, `files/${served}`)
    : sessionFolderMediaUrl(target.sessionRef, target.folderId, served)
}

/** A Session's screenshot as the same image Artifact generated media becomes; a game keeps none. */
async function screenshotArtifactOf(
  host: CapabilityHost,
  toolCallId: string,
  relativePath: string,
  inGames: boolean,
): Promise<AgentMediaItem | undefined> {
  if (inGames) return undefined
  const imageUrl = await screenshotMediaUrl(host, relativePath)
  if (!imageUrl) return undefined
  return {
    id: `screenshot-${toolCallId}`,
    type: 'image',
    state: 'done',
    mode: 'imageGen',
    settings: {},
    imageUrl,
    workspacePath: relativePath,
    createdAt: Date.now(),
  }
}

/** The complete tool result for a capture: path text for the model, the picture for the user. */
export async function screenshotToolResult(
  host: CapabilityHost,
  toolCallId: string,
  result: ScreenshotEngineResult,
): Promise<AgentToolResult<AgentMediaDetails | undefined>> {
  if (result.screenshotPath) {
    const inGames = isInGamesLibrary(host.workspaceDir)
    if (!inGames) noteGeneratedMedia(host.workspaceDir, [result.screenshotPath])
    try {
      sendToolImage(
        host.sessionId,
        toolCallId,
        workspaceFileToDataUri(host, result.screenshotPath),
        result.screenshotPath,
      )
    } catch (error) {
      logger.warn(`could not show screenshot in chat: ${error}`, LOG_SOURCE)
    }
    try {
      const item = await screenshotArtifactOf(host, toolCallId, result.screenshotPath, inGames)
      if (item) {
        return { content: [{ type: 'text', text: result.text }], details: { items: [item] } }
      }
    } catch (error) {
      logger.warn(`could not make the screenshot an Artifact: ${error}`, LOG_SOURCE)
    }
  }
  return textResult(result.text)
}
