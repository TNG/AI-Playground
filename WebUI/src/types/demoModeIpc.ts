import { z } from 'zod'
import type { IpcOkWith } from './ipcChannels'
import { HASHED_DEMO_PASSCODE } from '../lib/demoPasscode'

/** What the Setup Wizard saves; an omitted passcode keeps the stored one. */
export const DemoConfigUpdateSchema = z.object({
  isDemoModeEnabled: z.boolean(),
  demoModePasscode: z.string().regex(HASHED_DEMO_PASSCODE).optional(),
  demoModeResetInSeconds: z.number().int().min(1).nullable(),
})
export type DemoConfigUpdate = z.infer<typeof DemoConfigUpdateSchema>

/** `enteredDemoMode`: Demo Mode is on now and was off before the save, so the app should restart. */
export type DemoConfigSaveResult = IpcOkWith<{ enteredDemoMode: boolean }>
