import { deleteAgentSessionRecord } from '../persist/agentSessionFiles'
import { deleteAgentSession } from './piTurnRunner'
import { setTrialRunDeps, wipeTrialRuns } from './trialRuns'

/** No Trial Run outlives the app; wiped before the renderer reads Harness Session records. */
export async function wireTrialRuns(): Promise<void> {
  setTrialRunDeps({
    deleteHarnessSession: async (harnessSessionId) => {
      await deleteAgentSessionRecord(harnessSessionId)
      await deleteAgentSession(harnessSessionId)
    },
  })
  await wipeTrialRuns()
}
