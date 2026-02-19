/**
 * Type definitions for ComfyUI service
 */

/**
 * Device type for ComfyUI backend
 */
export type ComfyUIDeviceType = 'XPU' | 'CUDA' | 'CPU'

/**
 * Configuration for ComfyUI service paths
 */
export interface ComfyUIPaths {
  baseDir: string
  serviceDir: string
  pythonEnvDirCpu: string
  pythonEnvDirXpu: string
  pythonEnvDirCuda: string
}

/**
 * ComfyUI version information
 */
export interface ComfyUIVersion {
  version?: string
  releaseTag?: string
}

/**
 * Result of backend installation
 */
export interface InstallationResult {
  cpuInstalled: boolean
  xpuInstalled: boolean
  cudaInstalled: boolean
}
