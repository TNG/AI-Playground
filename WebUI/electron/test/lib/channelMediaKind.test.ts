import { describe, it, expect } from 'vitest'
import { channelMediaKind } from '@/lib/channelMediaKind'

describe('channelMediaKind', () => {
  it.each([
    ['speech.wav', 'voice'],
    ['speech.mp3', 'voice'],
    ['speech.ogg', 'voice'],
    ['cover.png', 'photo'],
    ['cover.jpg', 'photo'],
    ['cover.jpeg', 'photo'],
    ['cover.webp', 'photo'],
    ['clip.mp4', 'video'],
    ['clip.webm', 'video'],
  ])('classifies %s as %s', (file, kind) => {
    expect(channelMediaKind(file)).toBe(kind)
  })

  it.each(['spin.gif', 'model.glb', 'notes.pdf', 'readme.txt', 'game.html', 'noextension'])(
    'refuses %s',
    (file) => {
      expect(channelMediaKind(file)).toBeNull()
    },
  )

  it('ignores case', () => {
    expect(channelMediaKind('COVER.PNG')).toBe('photo')
    expect(channelMediaKind('Clip.WebM')).toBe('video')
    expect(channelMediaKind('AUDIO/WAV')).toBe('voice')
  })

  it('classifies a workspace path or media URL by its file name', () => {
    expect(channelMediaKind('/work/game/generated/speech.wav')).toBe('voice')
    expect(channelMediaKind('C:\\work\\generated\\cover.jpg')).toBe('photo')
    expect(channelMediaKind('aipg-media://outputs/clip.mp4')).toBe('video')
    expect(channelMediaKind('aipg-media://outputs/cover.png?v=2')).toBe('photo')
    expect(channelMediaKind('aipg-media://outputs/model.glb')).toBeNull()
  })

  it.each([
    ['audio/wav', 'voice'],
    ['audio/x-wav', 'voice'],
    ['audio/mpeg', 'voice'],
    ['audio/ogg', 'voice'],
    ['image/png', 'photo'],
    ['image/jpeg', 'photo'],
    ['image/webp', 'photo'],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
  ])('classifies mime type %s as %s', (mime, kind) => {
    expect(channelMediaKind(mime)).toBe(kind)
  })

  it.each(['image/gif', 'model/gltf-binary', 'application/pdf', 'text/plain'])(
    'refuses mime type %s',
    (mime) => {
      expect(channelMediaKind(mime)).toBeNull()
    },
  )

  it('classifies a data URI by its mime type', () => {
    expect(channelMediaKind('data:image/png;base64,AAA')).toBe('photo')
    expect(channelMediaKind('data:audio/wav;base64,AAA')).toBe('voice')
    expect(channelMediaKind('data:image/gif;base64,AAA')).toBeNull()
  })
})
