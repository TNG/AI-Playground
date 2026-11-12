export type PresetGate = { enabled: boolean; reason?: string }

type ServiceStatus = { serviceName: string; status: string }

/** A preset naming `requiresService` stays listed but greyed out until that service is installed. */
export function requiredServiceGate(
  requiresService: string | undefined,
  services: readonly ServiceStatus[],
  displayName: (serviceName: string) => string,
): PresetGate {
  if (!requiresService) return { enabled: true }
  const info = services.find((s) => s.serviceName === requiresService)
  if (info && info.status !== 'notInstalled') return { enabled: true }
  return {
    enabled: false,
    reason: `Install ${displayName(requiresService)} on the Setup page to use this preset.`,
  }
}
