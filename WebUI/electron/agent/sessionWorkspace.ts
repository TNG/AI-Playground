import { active, agentTurns } from './piAgentState.ts'
import { readAgentSessionWorkspaceDir } from '../persist/agentSessionFiles.ts'

/** A session's workspace: its live Pi session's, else its saved record's (a first turn has none yet). */
export async function sessionWorkspaceDir(sessionId: string): Promise<string | null> {
  const live = agentTurns.get(sessionId)?.live ?? (active?.sessionId === sessionId ? active : null)
  return live?.workspaceDir || (await readAgentSessionWorkspaceDir(sessionId))
}
