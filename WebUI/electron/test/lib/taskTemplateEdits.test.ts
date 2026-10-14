import { describe, expect, it } from 'vitest'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import {
  templateBackendChange,
  templateDeviceChange,
  templateProviderChange,
  type TemplateChoiceContext,
} from '@/lib/taskTemplateEdits'

const CHOICES: Record<string, string[]> = {
  'llamaCPP:': ['Llama-9B', 'Llama-27B'],
  'llamaCPP:0': ['Llama-9B', 'Llama-27B'],
  'openVINO:GPU.0': ['OV-GPU-7B', 'OV-GPU-14B'],
  'openVINO:NPU': ['OV-NPU-4B'],
}

const PROVIDER_MODELS: Record<string, string[]> = {
  openai: ['gpt-x', 'gpt-y'],
  anthropic: ['claude-y', 'claude-z'],
}

const context = (overrides: Partial<TemplateChoiceContext> = {}): TemplateChoiceContext => ({
  modelChoices: (backend, deviceId) => CHOICES[`${backend}:${deviceId ?? ''}`] ?? [],
  serviceDevice: (backend) =>
    backend === 'openVINO' ? { id: 'GPU.0', uuid: 'gpu-uuid' } : { id: '0', uuid: null },
  providerModels: (providerId) => PROVIDER_MODELS[providerId] ?? [],
  selectedProviderId: 'openai',
  ...overrides,
})

const TEMPLATE: AgentSessionSettings = {
  backend: 'llamaCPP',
  device: { id: '0', uuid: null },
  model: 'Llama-27B',
  contextSize: 32768,
}

describe('switching a template’s backend', () => {
  it('changes nothing when the backend is the same', () => {
    expect(templateBackendChange(TEMPLATE, 'llamaCPP', context())).toEqual({})
  })

  it('takes the local service’s device and the first model offered on it', () => {
    expect(templateBackendChange(TEMPLATE, 'openVINO', context())).toEqual({
      backend: 'openVINO',
      device: { id: 'GPU.0', uuid: 'gpu-uuid' },
      model: 'OV-GPU-7B',
    })
  })

  it('keeps the template’s cloud provider when it has one', () => {
    expect(
      templateBackendChange({ ...TEMPLATE, cloudProviderId: 'anthropic' }, 'cloud', context()),
    ).toEqual({ backend: 'cloud', cloudProviderId: 'anthropic', model: 'claude-y' })
  })

  it('takes the selected cloud provider when the template has none', () => {
    expect(templateBackendChange(TEMPLATE, 'cloud', context())).toEqual({
      backend: 'cloud',
      cloudProviderId: 'openai',
      model: 'gpt-x',
    })
  })

  it('leaves the model unset when the backend offers none', () => {
    const change = templateBackendChange(
      TEMPLATE,
      'openVINO',
      context({ serviceDevice: () => undefined }),
    )
    expect(change).toEqual({ backend: 'openVINO', device: undefined, model: undefined })
  })
})

describe('switching a template’s device', () => {
  const openVino: AgentSessionSettings = {
    backend: 'openVINO',
    device: { id: 'GPU.0', uuid: 'gpu-uuid' },
    model: 'OV-GPU-14B',
  }

  it('keeps the model when the new device still offers it', () => {
    expect(templateDeviceChange(TEMPLATE, { id: '0', uuid: 'x' }, context())).toEqual({
      device: { id: '0', uuid: 'x' },
    })
  })

  it('takes the first model of the new device when the old one is not offered there', () => {
    expect(templateDeviceChange(openVino, { id: 'NPU', uuid: null }, context())).toEqual({
      device: { id: 'NPU', uuid: null },
      model: 'OV-NPU-4B',
    })
  })
})

describe('switching a template’s cloud provider', () => {
  const cloud: AgentSessionSettings = {
    backend: 'cloud',
    cloudProviderId: 'openai',
    model: 'gpt-y',
  }

  it('keeps the model when the new provider serves it too', () => {
    expect(
      templateProviderChange({ ...cloud, model: 'shared' }, 'both', {
        ...context(),
        providerModels: () => ['other', 'shared'],
      }),
    ).toEqual({ cloudProviderId: 'both' })
  })

  it('takes the new provider’s first model otherwise', () => {
    expect(templateProviderChange(cloud, 'anthropic', context())).toEqual({
      cloudProviderId: 'anthropic',
      model: 'claude-y',
    })
  })
})
