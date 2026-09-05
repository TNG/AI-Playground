import { app } from 'electron'
import path from 'node:path'
import { packagedResourcesRoot } from './aipgRoot.ts'

export const externalResourcesDir = () =>
  path.resolve(app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../external/'))

export const getMediaDir = () => {
  let mediaDir: string
  if (process.env.USERPROFILE) {
    mediaDir = path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'media')
  } else if (process.env.HOME) {
    mediaDir = path.join(process.env.HOME, 'AI-Playground', 'media')
  } else {
    mediaDir = path.join(externalResourcesDir(), 'service', 'static', 'sd_out')
  }
  return mediaDir
}

/**
 * The game library: one folder per game the Game Agent preset produced, sibling to
 * `media/`. The user opens it directly (and the generated hub page lives here), so
 * it goes next to the other user-visible output rather than into app data.
 */
export const getGamesDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'games')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'games')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'games')
}

/** Generated TTS and other agent audio (sibling to `media/`, which holds Comfy output and `input/`). */
export const getAudioDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'audio')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'audio')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'audio')
}

/**
 * The user's chat threads: one JSON file per conversation plus `index.json`
 * (architecture-target §6.1). Sibling to `media/` so a folder copy takes the
 * conversations with it.
 */
export const getConversationsDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'conversations')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'conversations')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'conversations')
}

/**
 * Demo-mode conversations live here instead of the real library and are wiped
 * on exit (§6.1: session-scoped, never a write into the user's real library).
 */
export const getConversationsDemoDir = () => {
  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, 'Documents', 'AI-Playground', 'conversations-demo')
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, 'AI-Playground', 'conversations-demo')
  }
  return path.join(externalResourcesDir(), 'service', 'static', 'conversations-demo')
}
