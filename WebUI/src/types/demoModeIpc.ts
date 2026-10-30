import { z } from 'zod'

const BASE64 = '[A-Za-z0-9+/]+={0,2}'

/** What the Setup Wizard saves; an omitted passcode keeps the stored one. */
export const DemoConfigUpdateSchema = z.object({
  isDemoModeEnabled: z.boolean(),
  demoModePasscode: z
    .string()
    .regex(new RegExp(`^pbkdf2\\$[1-9]\\d{0,7}\\$${BASE64}\\$${BASE64}$`))
    .optional(),
  demoModeResetInSeconds: z.number().int().min(1).nullable(),
})
export type DemoConfigUpdate = z.infer<typeof DemoConfigUpdateSchema>
