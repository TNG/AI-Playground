export type AppSettingsSectionId =
  | 'language'
  | 'theme'
  | 'promptBarStyle'
  | 'huggingFace'
  | 'speech'
  | 'mediaModes'
  | 'mcp'
  | 'permissions'
  | 'hide'
  | 'remoteKernel'
  | 'advanced'

export type AppSettingsPartId =
  | 'language'
  | 'theme'
  | 'promptBarStyle'
  | 'huggingFace'
  | 'speech'
  | 'mediaModes'
  | 'mcp'
  | 'permissions'
  | 'hideMessages'
  | 'remoteKernel'
  | 'developer'
  | 'demoMode'

type DemoPolicy = 'block' | 'hide' | 'allow'

type PartSpec = { id: AppSettingsPartId; demo: DemoPolicy; needsPasscode?: true }
type SectionSpec = { id: AppSettingsSectionId; heading: boolean; parts: PartSpec[] }

export type AppSettingsPart = { id: AppSettingsPartId; blocked: boolean; disabled: boolean }
export type AppSettingsSectionLayout = {
  id: AppSettingsSectionId
  /** The section's own heading; single-part sections head themselves. */
  heading: boolean
  parts: AppSettingsPart[]
}

const SECTIONS: SectionSpec[] = [
  { id: 'language', heading: false, parts: [{ id: 'language', demo: 'block' }] },
  { id: 'theme', heading: false, parts: [{ id: 'theme', demo: 'hide' }] },
  { id: 'promptBarStyle', heading: false, parts: [{ id: 'promptBarStyle', demo: 'allow' }] },
  { id: 'huggingFace', heading: false, parts: [{ id: 'huggingFace', demo: 'block' }] },
  { id: 'speech', heading: false, parts: [{ id: 'speech', demo: 'block' }] },
  { id: 'mediaModes', heading: false, parts: [{ id: 'mediaModes', demo: 'block' }] },
  { id: 'mcp', heading: false, parts: [{ id: 'mcp', demo: 'block' }] },
  { id: 'permissions', heading: false, parts: [{ id: 'permissions', demo: 'block' }] },
  // The Hide group stays open in demo mode: with the feature enabled there,
  // both hiding and bringing messages back must work.
  { id: 'hide', heading: true, parts: [{ id: 'hideMessages', demo: 'allow' }] },
  { id: 'remoteKernel', heading: false, parts: [{ id: 'remoteKernel', demo: 'block' }] },
  {
    id: 'advanced',
    heading: true,
    parts: [
      { id: 'developer', demo: 'block' },
      { id: 'demoMode', demo: 'allow', needsPasscode: true },
    ],
  },
]

/** The App tab's sections as they render; one whose parts are all hidden is left out whole. */
export function appSettingsSections(state: {
  demoMode: boolean
  hasDemoPasscode: boolean
  developerMode: boolean
}): AppSettingsSectionLayout[] {
  return SECTIONS.map((section) => ({
    id: section.id,
    heading: section.heading,
    parts: section.parts
      .filter((part) => !(state.demoMode && part.demo === 'hide'))
      // Remote inference is a developer preview; the same flag hides it as the debug controls.
      .filter((part) => part.id !== 'remoteKernel' || state.developerMode)
      .map((part) => ({
        id: part.id,
        blocked: state.demoMode && part.demo === 'block',
        disabled: !!part.needsPasscode && !state.hasDemoPasscode,
      })),
  })).filter((section) => section.parts.length > 0)
}
