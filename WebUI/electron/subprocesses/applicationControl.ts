const POLICY_BLOCK = /application control policy has blocked|os error 4551|ERROR_VIRUS_INFECTED/i
// libuv does not map Win32 ERROR_VIRUS_INFECTED, so a blocked CreateProcess arrives as "spawn <exe> UNKNOWN".
const WIN32_SPAWN_UNKNOWN = /^spawn .*\bUNKNOWN\b/im

export const APPLICATION_CONTROL_USER_MESSAGE =
  'Windows blocked part of this component from running. On Windows 11 this is usually Smart App Control. Turn it off under Windows Security → App & browser control → Smart App Control, then try this step again.'

export function applicationControlHint(
  text: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const blocked =
    POLICY_BLOCK.test(text) || (platform === 'win32' && WIN32_SPAWN_UNKNOWN.test(text))
  return blocked ? APPLICATION_CONTROL_USER_MESSAGE : undefined
}
