export function levelZeroDeviceSelectorEnv(id?: string): { ONEAPI_DEVICE_SELECTOR: string } {
  return { ONEAPI_DEVICE_SELECTOR: `level_zero:${id ?? '*'}` }
}

export function cudaDeviceSelectorEnv(id?: string): { CUDA_VISIBLE_DEVICES: string } {
  return { CUDA_VISIBLE_DEVICES: id ?? '0' }
}

export function rocmDeviceSelectorEnv(id?: string): {
  HIP_VISIBLE_DEVICES: string
  ROCR_VISIBLE_DEVICES: string
} {
  const deviceId = id ?? '0'
  return {
    HIP_VISIBLE_DEVICES: deviceId,
    ROCR_VISIBLE_DEVICES: deviceId,
  }
}

export function vulkanDeviceSelectorEnv(id?: string): { GGML_VK_VISIBLE_DEVICES: string } {
  return { GGML_VK_VISIBLE_DEVICES: id ?? '0' }
}

export function openVinoDeviceSelectorEnv(id?: string): { OPENVINO_DEVICE: string } {
  return { OPENVINO_DEVICE: id ?? 'AUTO' }
}
