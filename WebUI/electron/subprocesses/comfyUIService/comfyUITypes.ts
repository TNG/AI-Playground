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
export type ComfyUIPaths = {
  baseDir: string
  serviceDir: string
  /** Single Python venv used by whatever backend is currently installed */
  pythonEnvDir: string
}

/**
 * ComfyUI version information
 */
export type ComfyUIVersion = {
  version?: string
  releaseTag?: string
}

/**
 * Result of a single-backend installation
 */
export type InstallationResult = {
  installedBackendType: ComfyUIDeviceType
}
