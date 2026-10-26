import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useModels } from '@/assets/js/store/models'
import { registerModelDownloader } from '@/assets/js/models/modelDownloadQueue'
import { aipgFetch } from '@/lib/loopbackAuth'
import { runModelDownload } from '@/lib/modelDownloader'

/** Points the Model Download queue at the ai-backend's downloader. */
export function startModelDownloader(): void {
  const globalSetup = useGlobalSetup()
  const models = useModels()
  registerModelDownloader({
    download: (list, options) =>
      runModelDownload(list, {
        apiHost: globalSetup.apiHost,
        hfToken: models.hfTokenIsValid ? models.hfToken : undefined,
        ...options,
      }),
    stop: async () => {
      await aipgFetch(`${globalSetup.apiHost}/api/stopDownloadModel`)
    },
    onModelCompleted: () => models.refreshModels(),
  })
}
