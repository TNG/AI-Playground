import { z } from 'zod'

/** What the Setup Wizard saves; an omitted passcode keeps the stored one. */
export const DemoConfigUpdateSchema = z.object({
  isDemoModeEnabled: z.boolean(),
  demoModePasscode: z.string().startsWith('pbkdf2$').optional(),
  demoModeResetInSeconds: z.number().int().min(1).nullable(),
})
export type DemoConfigUpdate = z.infer<typeof DemoConfigUpdateSchema>
