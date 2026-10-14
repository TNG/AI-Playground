import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { LlmBackend } from '@/assets/js/store/textInference'

type TemplateDevice = NonNullable<AgentSessionSettings['device']>

/** What a template edit may read to fill in the fields a backend or device switch invalidates. */
export type TemplateChoiceContext = {
  /** The local models a picker offers for that backend on that device, the default pick first. */
  modelChoices: (
    backend: Exclude<LlmBackend, 'cloud'>,
    deviceId: string | undefined,
  ) => readonly string[]
  /** A cloud provider's models; the app's model list only holds the selected provider's. */
  providerModels: (providerId: string) => readonly string[]
  serviceDevice: (backend: Exclude<LlmBackend, 'cloud'>) => TemplateDevice | undefined
  selectedProviderId: string
}

/** The fields to change when a template moves to another backend; a model never spans backends. */
export function templateBackendChange(
  template: AgentSessionSettings,
  backend: LlmBackend,
  context: TemplateChoiceContext,
): AgentSessionSettings {
  if (template.backend === backend) return {}
  if (backend === 'cloud') {
    const cloudProviderId = template.cloudProviderId ?? context.selectedProviderId
    return { backend, cloudProviderId, model: context.providerModels(cloudProviderId)[0] }
  }
  const device = context.serviceDevice(backend)
  return { backend, device, model: context.modelChoices(backend, device?.id)[0] }
}

/** The fields to change for another device; the model stays unless that device does not offer it. */
export function templateDeviceChange(
  template: AgentSessionSettings,
  device: TemplateDevice,
  context: TemplateChoiceContext,
): AgentSessionSettings {
  const backend = template.backend === 'openVINO' ? 'openVINO' : 'llamaCPP'
  const choices = context.modelChoices(backend, device.id)
  if (template.model && choices.includes(template.model)) return { device }
  return { device, model: choices[0] }
}

/** The fields to change for another cloud provider; the model stays if that provider serves it. */
export function templateProviderChange(
  template: AgentSessionSettings,
  cloudProviderId: string,
  context: TemplateChoiceContext,
): AgentSessionSettings {
  const models = context.providerModels(cloudProviderId)
  if (template.model && models.includes(template.model)) return { cloudProviderId }
  return { cloudProviderId, model: models[0] }
}
