// Hidden-window lifecycle policy (docs/architecture-target.md §5.1).
//
// Main — never the renderer — decides whether closing the application window
// ends the app or merely hides it. Hiding keeps the renderer (and everything it
// drives today: chat turns, ComfyUI websocket runs, Home Agent setup) alive
// while the user is not looking; an explicit quit still tears everything down
// through the existing `before-quit` shutdown.
//
// The policy itself is a pure function so the decision table is unit-tested
// without an Electron app: every input is named, every combination is cheap to
// enumerate.

export type CloseDecision = 'hide' | 'close'

export type ClosePolicyInputs = {
  /** The Home Agent backend is installed and its channel server is running. */
  homeAgentRunning: boolean
  /** The renderer reported tracked work (an activity is in flight). */
  rendererBusy: boolean
  /** Main itself is running an agent turn (Pi session). */
  agentTurnActive: boolean
}

/**
 * Closing the app window hides it while headless work would be orphaned by a
 * quit — a Home Agent serving channels, an in-flight agent turn, or anything
 * the renderer reported busy. Otherwise the normal close/quit policy applies.
 */
export function resolveClosePolicy(inputs: ClosePolicyInputs): CloseDecision {
  const headlessWork = inputs.homeAgentRunning || inputs.rendererBusy || inputs.agentTurnActive
  return headlessWork ? 'hide' : 'close'
}
