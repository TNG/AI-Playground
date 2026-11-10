import { FILES_CAPABILITY_ID } from '@/types/agentCapabilities'
import type { AgentCapability } from './types.ts'

// No tools of its own: the builtins live in piToolOperations.ts, and the session build
// keeps them for a preset that owns its prompt only while this is enabled.
export const filesCapability: AgentCapability = {
  id: FILES_CAPABILITY_ID,
  label: 'Files and shell',
  summary:
    'Reads, writes and edits files in the Session Folder and its Mounted Folders, and runs ' +
    'shell commands there.',
}
