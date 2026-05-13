/**
 * Shared HTML help message for the Home Agent Telegram bot.
 * Used in both the verification message (main process) and the /help reply (renderer).
 */
export const HOME_AGENT_HELP_BODY =
  '🤖 <b>Available commands</b>\n\n' +
  '<code>/imgGen </code><i>&lt;prompt&gt;</i>\n' +
  'Generate an image from a text prompt.\n' +
  'Example: <code>/imgGen a sunset over snowy mountains</code>\n\n' +
  '/help\n' +
  'Show this help message.\n\n' +
  'Any other message is sent to the AI chat model and the reply is returned to you.'
