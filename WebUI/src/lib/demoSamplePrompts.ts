export const FALLBACK_SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    title: 'Prompt Example',
    description: 'Ask a science question and get an answer:',
    prompt: 'Why does water expand when it freezes?',
    mode: 'chat',
  },
  {
    title: 'Image Generation Example',
    description: 'Create a fantastic image from a detailed prompt:',
    prompt:
      'A close-up photo of a hummingbird hovering to get nectar from a red rose with drops of dew. Iridescent blue and green feathers, wings a blur. Depth of field. High Dynamic Range.',
    mode: 'imageGen',
  },
  {
    title: 'Image Editing Example',
    description: 'Edit a photo by describing what to change. An image is already given:',
    prompt: 'Remove people from the background',
    mode: 'imageEdit',
  },
  {
    title: 'Sketch to Photo Example',
    description: 'Turn a sketch into a photo by describing the scene:',
    prompt: 'Photo of a modern apartment building, tropical resort, sunset view',
    mode: 'imageEdit',
    presetName: 'Sketch to Photo',
  },
  {
    title: 'Video Generation Example',
    description: 'Create a short video from a text description.',
    prompt: 'A golden retriever running through a field of sunflowers on a sunny day',
    mode: 'video',
  },
]

/** The preset's own sample wins over the mode's general one. */
export function sampleFor(
  samples: SamplePrompt[],
  mode: ModeType,
  presetName: string | undefined,
): SamplePrompt | undefined {
  return (
    samples.find((s) => s.mode === mode && s.presetName === presetName) ??
    samples.find((s) => s.mode === mode && !s.presetName)
  )
}

/** Disable Prompt lets through only a sample written for this mode, unchanged. */
export function isSamplePrompt(samples: SamplePrompt[], mode: ModeType, text: string): boolean {
  const prompt = text.trim()
  return prompt !== '' && samples.some((s) => s.mode === mode && s.prompt.trim() === prompt)
}
