// Kokoro ids are accent + gender + a name (`af_heart`), not ISO language codes.
// `af` is American English female — reading it as Afrikaans is what a bare id invites.

const ACCENT_BY_PREFIX: Record<string, string> = {
  af: 'American English female',
  am: 'American English male',
  bf: 'British English female',
  bm: 'British English male',
}

/** "American English female voice Heart (af_heart)". Unknown ids come back unchanged. */
export function describeKokoroVoice(id: string): string {
  const voice = id.trim()
  const match = /^([a-z]{2})_([a-z0-9]+)$/i.exec(voice)
  const accent = match ? ACCENT_BY_PREFIX[match[1].toLowerCase()] : undefined
  if (!accent || !match) return voice
  const name = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase()
  return `${accent} voice ${name} (${voice})`
}

/** Appended to the TTS tool description while Kokoro is the selected engine. */
export function kokoroEngineNote(voiceId: string): string {
  return (
    '\n\nENGINE: The selected engine is Kokoro. It speaks with the voice configured in Text to ' +
    `Speech settings (${describeKokoroVoice(voiceId)}). \`speaker\`, \`language\`, and ` +
    '`instruct` do not change this voice. Do not offer to switch language through this tool.'
  )
}

/** Appended to the TTS tool description while an external endpoint is the selected engine. */
export function externalTtsEngineNote(voiceId: string): string {
  const voice = voiceId.trim()
  const named = voice ? `the configured voice (${voice})` : 'its configured voice'
  return (
    '\n\nENGINE: The selected engine is an external endpoint. It speaks with ' +
    `${named}. \`speaker\`, \`language\`, and \`instruct\` do not change this voice. Do not ` +
    'infer a language from the voice id.'
  )
}
