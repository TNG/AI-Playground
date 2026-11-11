/** Plain text made safe inside Telegram HTML and Slack mrkdwn: `&`, `<` and `>` escaped. */
export function escapeMarkupText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
