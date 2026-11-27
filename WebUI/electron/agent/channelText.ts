/** A message's text: plain `header` and `footer` lines around a body that is markdown unless `plain`. */
export type ChannelText = { header?: string; text: string; footer?: string; plain?: boolean }

export function plainTextOf({ header, text, footer }: ChannelText): string {
  return [header, text, footer].filter(Boolean).join('\n')
}
