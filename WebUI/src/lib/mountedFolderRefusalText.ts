import type { MountedFolderRefusal } from '@/lib/mountedFolders'

export function mountedFolderRefusalText(
  refused: MountedFolderRefusal | undefined,
  languages: Record<string, string>,
): string {
  if (!refused) return ''
  if (refused.reason === 'mounted') {
    return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_MOUNTED.replace(
      '{folder}',
      refused.folder,
    )
  }
  if (refused.reason === 'contains-mounted') {
    return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_CONTAINS_MOUNTED.replaceAll(
      '{folder}',
      refused.folder,
    )
  }
  return {
    'too-broad': languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_TOO_BROAD,
    home: languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_HOME,
  }[refused.reason]
}
