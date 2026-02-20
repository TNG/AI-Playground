/**
 * Construct an environment mapping that selects a Level Zero device.
 *
 * @param id - Optional device identifier; when omitted, the selector targets all Level Zero devices.
 * @returns An object with `ONEAPI_DEVICE_SELECTOR` set to `level_zero:<id>` or `level_zero:*` if `id` is undefined.
 */
export function levelZeroDeviceSelectorEnv(id?: string): { ONEAPI_DEVICE_SELECTOR: string } {
  return { ONEAPI_DEVICE_SELECTOR: `level_zero:${id ?? '*'}` }
}

/**
 * Produces an environment variable mapping to select which CUDA device(s) are visible.
 *
 * @param id - The GPU device ID or comma-separated list to expose; when omitted uses '0'.
 * @returns An object with `CUDA_VISIBLE_DEVICES` set to the provided `id` or `'0'`.
 */
export function cudaDeviceSelectorEnv(id?: string): { CUDA_VISIBLE_DEVICES: string } {
  return { CUDA_VISIBLE_DEVICES: id ?? '0' }
}

/**
 * Builds an environment object to select the Vulkan device used by GGML.
 *
 * @param id - The device identifier to expose to GGML; when omitted, uses `'0'`.
 * @returns An object with `GGML_VK_VISIBLE_DEVICES` set to the chosen device identifier
 */
export function vulkanDeviceSelectorEnv(id?: string): { GGML_VK_VISIBLE_DEVICES: string } {
  return { GGML_VK_VISIBLE_DEVICES: id ?? '0' }
}

export function openVinoDeviceSelectorEnv(id?: string): { OPENVINO_DEVICE: string } {
  return { OPENVINO_DEVICE: id ?? 'AUTO' }
}