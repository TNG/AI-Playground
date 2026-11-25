import type { BackendServiceName } from '@/assets/js/store/backendServices'

const KNOWN_STEPS: Record<BackendServiceName, string[]> = {
  'ai-backend': ['start', 'install dependencies'],
  'llamacpp-backend': ['start', 'download', 'extract', 'configure-service'],
  'openvino-backend': ['start', 'download', 'extract', 'install python'],
  'comfyui-backend': [
    'start',
    // Linux-only step, emitted before the clone. Omitting it made Linux installs
    // fall back to showing raw debug messages instead of a progress label.
    'linux dependencies',
    'install comfyUI',
    'configure comfyUI',
    'install builtin custom nodes',
    'install comfyUI manager',
  ],
  'home-agent-backend': ['start', 'install dependencies'],
  'qwen3-tts-backend': ['start', 'install dependencies'],
  'whisper-backend': ['start', 'install dependencies'],
  'hermes-backend': ['start', 'install hermes', 'install dependencies'],
}

const STEP_DISPLAY_NAMES: Record<string, string> = {
  start: 'Preparing...',
  download: 'Downloading...',
  extract: 'Extracting...',
  'configure-service': 'Configuring SSD offload...',
  'install dependencies': 'Installing dependencies...',
  'install python': 'Installing Python environment...',
  'linux dependencies': 'Installing system packages...',
  'install comfyUI': 'Installing ComfyUI...',
  'configure comfyUI': 'Configuring...',
  'install builtin custom nodes': 'Installing custom nodes...',
  'install comfyUI manager': 'Installing ComfyUI Manager...',
  'install hermes': 'Fetching Hermes Agent...',
}

export function setupProgressLabel(
  serviceName: BackendServiceName,
  progress: SetupProgress,
): string {
  const steps = KNOWN_STEPS[serviceName] ?? []
  const stepIdx = steps.indexOf(progress.step)
  const label = STEP_DISPLAY_NAMES[progress.step] ?? progress.debugMessage
  return stepIdx >= 0 ? `${label} (${stepIdx + 1}/${steps.length})` : label
}
