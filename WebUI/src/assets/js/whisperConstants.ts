/**
 * Models offered by the standalone (torch, non-OpenVINO) Whisper STT engine. Each
 * `repo` is a HuggingFace id transformers can load; they download to the shared STT
 * model dir via the standard download popup, and the whisper-backend resolves them
 * from there (see whisperBackendService.modelPathEnv / transcription_engine).
 */
export const WHISPER_STANDALONE_MODELS = [
  { repo: 'openai/whisper-base', label: 'Whisper base' },
  { repo: 'openai/whisper-small', label: 'Whisper small' },
  { repo: 'openai/whisper-large-v3-turbo', label: 'Whisper large v3 turbo' },
] as const

export type WhisperStandaloneModel = (typeof WHISPER_STANDALONE_MODELS)[number]['repo']

export const DEFAULT_WHISPER_STANDALONE_MODEL: WhisperStandaloneModel =
  WHISPER_STANDALONE_MODELS[0].repo
