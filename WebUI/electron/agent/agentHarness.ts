import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { IpcMutationResult } from '@/types/ipcChannels'
import { startAgentTurn } from './piTurnRunner.ts'
import { startHermesTurn } from './hermes/hermesTurnRunner.ts'

/** Runs a turn on the harness its preset names; both keep their turn in `agentTurns`, so one cancel serves both. */
export function startAgentTurnOnHarness(
  turnId: string,
  prompt: string,
  config: AgentModeTurnConfig,
): Promise<IpcMutationResult> {
  return config.harness === 'hermes'
    ? startHermesTurn(turnId, prompt, config)
    : startAgentTurn(turnId, prompt, config)
}
