/** NVIDIA CUDA and AMD ROCm installs have no OpenVINO backend. */
export function excludesOpenVino(mode: string | null | undefined): boolean {
  return mode === 'nvidia' || mode === 'amd'
}

/** Torch extra pinned by a vendor product mode. null keeps the platform default. */
export function pinnedTorchExtra(mode: string | null | undefined): 'cuda' | 'rocm' | null {
  if (mode === 'nvidia') return 'cuda'
  if (mode === 'amd') return 'rocm'
  return null
}

/** Which PyTorch stack a product mode installs. `default` is the Intel/CPU build. */
export function torchStackForMode(mode: string | null | undefined): 'cuda' | 'rocm' | 'default' {
  if (mode === 'nvidia') return 'cuda'
  if (mode === 'amd') return 'rocm'
  return 'default'
}

/** uv `--torch-backend` name for the ROCm index that publishes torch 2.13. */
export const ROCM_TORCH_BACKEND = 'rocm7.2'

/** Matches the CUDA index the NVIDIA install already selects. */
export const CUDA_TORCH_BACKEND = 'cu128'
