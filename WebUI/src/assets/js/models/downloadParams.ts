// Turn selected library rows into the `DownloadModelParam[]` that
// `dialogs.showDownloadDialog` already knows how to handle, so batch download
// needs no new download machinery.
import type { ModelEntry } from './types'

/** Resolves the on-disk directory for a download, i.e. `models.getModelPath`. */
export type ModelPathResolver = (type: string, backend: string) => string

/**
 * A vision llama.cpp model is useless without its multimodal projector, so the
 * companion repo is queued alongside it — the same rule
 * `textInference.getDownloadParamsForCurrentModelIfRequired` applies for the
 * active chat model.
 *
 * Entries are deduplicated by `repo_id` because `DownloadDialog` keys its rows on
 * it, and an mmproj shared by two models would otherwise appear twice.
 */
export function entriesToDownloadParams(
  entries: readonly ModelEntry[],
  resolvePath: ModelPathResolver,
): DownloadModelParam[] {
  const params: DownloadModelParam[] = []
  const seen = new Set<string>()

  const add = (repoId: string, entry: ModelEntry) => {
    if (seen.has(repoId)) return
    seen.add(repoId)
    params.push({
      repo_id: repoId,
      type: entry.pathKey,
      backend: entry.serviceBackend,
      model_path: resolvePath(entry.pathKey, entry.serviceBackend),
      additionalLicenseLink: entry.additionalLicenseLink,
    })
  }

  for (const entry of entries) {
    if (entry.downloaded) continue
    add(entry.name, entry)
    if (entry.capabilities.mmproj) add(entry.capabilities.mmproj, entry)
  }

  return params
}
