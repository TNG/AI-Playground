export type Qwen3TtsSpeakerId =
  | 'Vivian'
  | 'Serena'
  | 'Uncle_Fu'
  | 'Dylan'
  | 'Eric'
  | 'Ryan'
  | 'Aiden'
  | 'Ono_Anna'
  | 'Sohee'

export type Qwen3TtsLanguage =
  | 'Auto'
  | 'Chinese'
  | 'English'
  | 'Japanese'
  | 'Korean'
  | 'German'
  | 'French'
  | 'Russian'
  | 'Portuguese'
  | 'Spanish'
  | 'Italian'

export type Qwen3TtsSynthesisMode = 'custom_voice' | 'voice_design'

export const QWEN3_TTS_SPEAKERS: Array<{
  id: Qwen3TtsSpeakerId
  description: string
  nativeLanguage: string
}> = [
  {
    id: 'Vivian',
    description: 'Bright, slightly edgy young female voice.',
    nativeLanguage: 'Chinese',
  },
  { id: 'Serena', description: 'Warm, gentle young female voice.', nativeLanguage: 'Chinese' },
  {
    id: 'Uncle_Fu',
    description: 'Seasoned male voice with a low, mellow timbre.',
    nativeLanguage: 'Chinese',
  },
  { id: 'Dylan', description: 'Youthful Beijing male voice.', nativeLanguage: 'Chinese (Beijing)' },
  { id: 'Eric', description: 'Lively Chengdu male voice.', nativeLanguage: 'Chinese (Sichuan)' },
  { id: 'Ryan', description: 'Dynamic male voice.', nativeLanguage: 'English' },
  { id: 'Aiden', description: 'Sunny American male voice.', nativeLanguage: 'English' },
  { id: 'Ono_Anna', description: 'Playful Japanese female voice.', nativeLanguage: 'Japanese' },
  { id: 'Sohee', description: 'Warm Korean female voice.', nativeLanguage: 'Korean' },
]

export const QWEN3_TTS_LANGUAGES: Qwen3TtsLanguage[] = [
  'Auto',
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Russian',
  'Portuguese',
  'Spanish',
  'Italian',
]

export type Qwen3TtsApiResponse<T> = {
  code: number
  data?: T
  message?: string
}

export type Qwen3TtsSynthesizeResult = {
  audioBase64: string
  sampleRate: number
  mediaType: string
  speaker: string
  language: string
  mode: Qwen3TtsSynthesisMode
}
