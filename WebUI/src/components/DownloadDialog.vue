<template>
  <div class="dialog-container z-50">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        role="dialog"
        aria-label="Model download"
        class="flex max-h-[88vh] w-[min(1100px,92vw)] flex-col items-center justify-center gap-8 overflow-hidden rounded-3xl bg-card px-10 py-10 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <!-- A batch of tens of models used to grow the box past the screen, taking
             the terms checkbox and the buttons with it. The list scrolls instead,
             and everything needed to act on it stays in view. -->
        <div v-if="showConfirm" class="flex min-h-0 w-full flex-col items-center gap-5 text-center">
          <div class="flex flex-col items-center gap-1">
            <p>{{ i18nState.DOWNLOADER_CONFRIM_TIP }}</p>
            <p class="text-sm text-muted-foreground">
              {{ modelCountLabel }}
              <template v-if="totalDownloadSize"> · {{ totalDownloadSize }}</template>
            </p>
            <p v-if="alreadyDownloadingLabel" class="text-sm text-muted-foreground">
              {{ alreadyDownloadingLabel }}
            </p>
          </div>
          <div class="min-h-0 w-full flex-1 overflow-y-auto">
            <table class="text-left w-full">
              <thead class="sticky top-0 z-10 bg-card">
                <tr class="text-center text-muted-foreground font-bold">
                  <td class="text-left">{{ languages.DOWNLOADER_MODEL }}</td>
                  <td>{{ languages.DOWNLOADER_FILE_SIZE }}</td>
                  <td>{{ languages.DOWNLOADER_GATED }}</td>
                  <td>{{ languages.DOWNLOADER_INFO }}</td>
                  <td>{{ languages.DOWNLOADER_LICENSE }}</td>
                  <td>{{ languages.DOWNLOADER_REASON }}</td>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in downloadModelRender" :key="item.repo_id">
                  <td>{{ item.repo_id }}</td>
                  <td>
                    <div class="flex flex-col items-center">
                      <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                      <span v-else>{{ item.size }}</span>
                    </div>
                  </td>
                  <td>
                    <div class="flex flex-col items-center">
                      <span v-if="sizeRequesting" class="svg-icon i-loading w-4 h-4"></span>
                      <div v-else>
                        <svg
                          v-if="item.gated"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1"
                          stroke="currentColor"
                          class="size-6 ml-2"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                          />
                        </svg>
                        <svg
                          v-else
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke-width="1"
                          stroke="currentColor"
                          class="size-6 ml-2"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                          />
                        </svg>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="flex flex-col items-center">
                      <a
                        :href="getInfoUrl(item.repo_id, item.type)"
                        target="_blank"
                        class="text-primary text-sm"
                      >
                        {{ i18nState.DOWNLOADER_TERMS }}
                      </a>
                    </div>
                  </td>
                  <td>
                    <div
                      class="flex flex-col items-center"
                      v-if="item.additionalLicenseLink !== undefined"
                    >
                      <a
                        :href="item.additionalLicenseLink"
                        target="_blank"
                        class="text-primary text-sm"
                      >
                        {{ i18nState.DOWNLOADER_TERMS }}
                      </a>
                    </div>
                    <div class="flex flex-col items-center" v-else>-</div>
                  </td>
                  <td class="items-center text-sm text-green-400">
                    {{ getFunctionTip(item.type) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex w-full shrink-0 flex-col items-center gap-5">
            <div
              v-if="
                downloadModelRender.some((i) => i.gated && !i.accessGranted) &&
                downloadModelRender.length === 1
              "
              class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg"
            >
              <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO_SINGLE }}</span>
              <span class="text-left">
                {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : '' }}
                {{
                  downloadModelRender.some((i) => i.gated)
                    ? languages.DOWNLOADER_GATED_ACCEPT_SINGLE
                    : ''
                }}
                {{
                  downloadModelRender.some((i) => !i.accessGranted)
                    ? languages.DOWNLOADER_ACCESS_ACCEPT_SINGLE
                    : ''
                }}
              </span>
            </div>
            <div
              v-if="
                downloadModelRender.some((i) => i.gated && !i.accessGranted) &&
                downloadModelRender.length > 1
              "
              class="flex flex-col items-center gap-2 p-4 border border-red-600 bg-red-600/10 rounded-lg"
            >
              <span class="font-bold mx-4">{{ languages.DOWNLOADER_ACCESS_INFO }}</span>
              <span class="text-left">
                {{ !models.hfTokenIsValid ? languages.DOWNLOADER_GATED_TOKEN : '' }}
                {{
                  downloadModelRender.some((i) => i.gated) ? languages.DOWNLOADER_GATED_ACCEPT : ''
                }}
                {{
                  downloadModelRender.some((i) => !i.accessGranted)
                    ? languages.DOWNLOADER_ACCESS_ACCEPT
                    : ''
                }}
              </span>
            </div>
            <div
              v-if="modelFolderReadOnly"
              class="flex flex-col items-center gap-2 p-4 border border-amber-500 bg-amber-500/10 rounded-lg"
            >
              <span class="text-left">{{ languages.DOWNLOADER_READONLY_MODEL_DIR }}</span>
            </div>
            <label v-if="!modelFolderReadOnly" class="flex items-center gap-2">
              <Checkbox v-model="readTerms" />
              <span class="text-sm text-left">{{ languages.DOWNLOADER_TERMS_TIP }}</span>
            </label>
            <div class="flex justify-center items-center gap-9">
              <button @click="cancelConfirm" class="bg-muted text-foreground py-1 px-4 rounded">
                {{ i18nState.COM_CANCEL }}
              </button>
              <button
                @click="confirmDownload"
                :disabled="
                  modelFolderReadOnly ||
                  sizeRequesting ||
                  !readTerms ||
                  downloadModelRender.every((i) => !i.accessGranted)
                "
                class="bg-primary py-1 px-4 rounded"
              >
                {{ i18nState.COM_CONFIRM }}
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="hashError" class="flex flex-col items-center justify-center gap-4">
          <p>{{ errorText }}</p>
          <p
            v-if="downloadErrorRetryable"
            class="text-sm text-muted-foreground text-center max-w-md"
          >
            {{ i18nState.ERR_DOWNLOAD_RESUME_HINT }}
          </p>
          <div class="flex flex-wrap justify-center items-center gap-4">
            <button
              v-if="downloadErrorRetryable"
              type="button"
              @click="retryDownload"
              class="bg-primary py-1 px-4 rounded"
            >
              {{ i18nState.COM_RETRY }}
            </button>
            <button type="button" @click="close" class="bg-red-500 py-1 px-4 rounded">
              {{ i18nState.COM_CLOSE }}
            </button>
          </div>
        </div>
        <template v-else>
          <p v-if="wait?.status === 'queued'">{{ i18nState.MODEL_DOWNLOAD_QUEUED }}</p>
          <progress-bar :text="allDownloadTip" :percent="taskPercent" class="w-3/4"></progress-bar>
          <progress-bar :text="curDownloadTip" :percent="percent" class="w-3/4"></progress-bar>
          <button @click="cancelDownload" class="bg-red-500 py-1 px-4">
            {{ i18nState.COM_CANCEL }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import ProgressBar from './ProgressBar.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { EtaEstimator } from '@/lib/etaEstimator'
import { fetchModelMeta, type ModelDownloadError } from '@/lib/modelDownloader'
import { parseHumanSize, sumHumanSizes } from '@/lib/humanSize'
import { createCancellation } from '@/assets/js/errors/appError'
import {
  modelDownloads,
  type ModelDownloadOutcome,
  type ModelDownloadWaiter,
} from '@/assets/js/models/modelDownloadQueue'
import { holdOpenDownloadQuestion } from '@/assets/js/models/openDownloadQuestions'
import { channelQuestionTemplates } from '@/lib/channelQuestionWording'

const i18nState = useI18N().state
const languages = i18nState
const globalSetup = useGlobalSetup()
const modelFolderReadOnly = computed(() => globalSetup.state.modelFolderReadOnly === true)
const models = useModels()
const dialogStore = useDialogStore()

const { downloadList, currentDownloadRequest } = storeToRefs(dialogStore)

const showConfirm = ref(false)
const sizeRequesting = ref(false)
const hashError = ref(false)
const errorText = ref('')
const downloadErrorRetryable = ref(false)
const animate = ref(false)
const readTerms = ref(false)
const downloadModelRender = ref<DownloadModelRender[]>([])

// Progress-mode requests wait in the Model Download queue under their own group.
let waiter: ModelDownloadWaiter | null = null
let stopHolding: () => void = () => {}
const group = computed(() => {
  const options = currentDownloadRequest.value?.options
  return options?.mode === 'progress' ? options.group : ''
})
const wait = computed(() => (group.value ? modelDownloads().snapshot(group.value) : null))
const etaEstimator = new EtaEstimator(100)
const eta = ref('')

const percent = computed(() => wait.value?.progress?.percent ?? 0)
const taskPercent = computed(() => wait.value?.progress?.taskPercent ?? 0)
const allDownloadTip = computed(() => {
  const progress = wait.value?.progress
  return `${i18nState.DOWNLOADER_DONWLOAD_TASK_PROGRESS} ${progress?.completed ?? 0}/${progress?.total ?? downloadModelRender.value.length}`
})
const curDownloadTip = computed(() => {
  const progress = wait.value?.progress
  if (!progress?.speed) return ''
  return `${i18nState.COM_DOWNLOAD_MODEL} ${progress.repoId}\r\n${progress.downloadSize}/${progress.totalSize} ${progress.percent}% ${i18nState.COM_DOWNLOAD_SPEED}: ${progress.speed} ETA: ${eta.value}`
})
watch(
  () => wait.value?.progress,
  (progress) => {
    if (progress?.speed !== undefined) eta.value = etaEstimator.updateAndEstimate(progress.percent)
  },
)

const modelCountLabel = computed(() =>
  i18nState.DOWNLOADER_MODEL_COUNT.replace('{count}', String(downloadModelRender.value.length)),
)

const alreadyDownloadingLabel = computed(() => {
  const already = currentDownloadRequest.value?.options.alreadyDownloading ?? []
  if (already.length === 0) return ''
  return i18nState.DOWNLOADER_ALREADY_DOWNLOADING.replace(
    '{models}',
    already.map((model) => model.repo_id).join(', '),
  )
})

// What the whole batch costs. With one model the per-row size says it already;
// with thirty it is the only number that matters before confirming.
//
// All-or-nothing on purpose: `sumHumanSizes` skips what it cannot parse, and a
// model the metadata call returned no size for ('' or '???') would then be
// silently left out — a total that understates a multi-GB download is worse than
// no total at all.
const totalDownloadSize = computed(() => {
  if (sizeRequesting.value) return undefined
  const sizes = downloadModelRender.value.map((i) => i.size)
  if (sizes.some((size) => parseHumanSize(size) === undefined)) return undefined
  return sumHumanSizes(sizes)
})

watch(
  () => currentDownloadRequest.value?.id,
  async (id) => {
    if (id === undefined) {
      stopHolding()
      waiter = null
      return
    }
    nextTick(() => {
      animate.value = true
    })
    await initializeDownloadDialog()
    animate.value = false
  },
  { immediate: true },
)

async function initializeDownloadDialog() {
  const request = currentDownloadRequest.value
  stopHolding()
  waiter = null
  const options = request?.options
  const joined = options?.mode === 'progress' && options.joined === true
  showConfirm.value = !joined
  hashError.value = false
  downloadErrorRetryable.value = false
  etaEstimator.reset()
  eta.value = ''
  downloadModelRender.value = downloadList.value.map((item) => {
    return { size: '???', ...item, ...(joined ? { accessGranted: true } : {}) }
  })
  readTerms.value = false
  if (request && options?.mode === 'progress') {
    waiter = modelDownloads().waiter(options.group)
    const uncovered = waiter.attach(downloadList.value)
    if (joined && uncovered.length === 0) {
      waiter.release()
      void settleFromQueue(request.id, waiter)
      return
    }
    const asked = waiter
    stopHolding = holdOpenDownloadQuestion({
      waiter: asked,
      models: downloadList.value,
      join: () => {
        showConfirm.value = false
        asked.release()
        void settleFromQueue(request.id, asked)
      },
    })
  }

  sizeRequesting.value = true
  try {
    const meta = await fetchModelMeta(downloadList.value, {
      apiHost: globalSetup.apiHost,
      hfToken: models.hfToken,
    })
    const byKey = new Map(meta.map((m) => [`${m.repo_id}_${m.type}`, m]))
    for (const item of downloadModelRender.value) {
      const m = byKey.get(`${item.repo_id}_${item.type}`)
      item.size = m?.size || ''
      item.gated = m?.gated || false
      item.accessGranted = m?.accessGranted || false
    }
    sizeRequesting.value = false
  } catch (ex) {
    sizeRequesting.value = false
    dialogStore.downloadFailed({ type: 'error', error: ex })
    dialogStore.closeDownloadDialog()
  }
}

function getInfoUrl(repoId: string, type: string) {
  if (type === 'upscale') {
    return 'https://github.com/xinntao/Real-ESRGAN'
  }

  switch (repoId) {
    case 'Lykon/dreamshaper-8':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'Lykon/dreamshaper-8-inpainting':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'RunDiffusion/Juggernaut-XL-v9':
      return 'https://huggingface.co/spaces/CompVis/stable-diffusion-license'
    case 'microsoft/Phi-3-mini-4k-instruct':
      return 'https://huggingface.co/microsoft/Phi-3-mini-4k-instruct/resolve/main/LICENSE'
    case 'BAAI/bge-large-en-v1.5':
      return 'https://huggingface.co/datasets/choosealicense/licenses/blob/main/markdown/mit.md'
    case 'latent-consistency/lcm-lora-sdv1-5':
      return 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md'
    case 'latent-consistency/lcm-lora-sdxl':
      return 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md'
  }

  return `https://huggingface.co/${repoId.split('/').slice(0, 2).join('/')}`
}

function getFunctionTip(type: string): string {
  switch (type) {
    case 'llm':
    case 'ggufLLM':
    case 'openvinoLLM':
      return i18nState.DOWNLOADER_FOR_ANSWER_GENERATE
    case 'embedding':
      return i18nState.DOWNLOADER_FOR_RAG_QUERY
    default:
      return 'Undefined'
  }
}

function accessibleModels(): DownloadModelParam[] {
  return downloadModelRender.value
    .filter((item) => item.accessGranted === true)
    .map(({ size: _size, gated: _gated, accessGranted: _access, ...model }) => model)
}

function downloadErrorText(detail: ModelDownloadError | undefined): string {
  switch (detail?.errType) {
    case 'not_enough_disk_space':
      return i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace(
        '{requires_space}',
        detail.requiresSpace ?? '',
      ).replace('{free_space}', detail.freeSpace ?? '')
    case 'repositories_not_found':
      return i18nState.ERROR_REPO_NOT_EXISTS
    case 'download_exception':
      return i18nState.ERR_DOWNLOAD_FAILED
    case 'runtime_error':
      return i18nState.ERROR_RUNTIME_ERROR
    default:
      return i18nState.ERROR_GENERATE_UNKONW_EXCEPTION
  }
}

/** Settles the shown request from its waiter's outcome in the Model Download queue. */
async function settleFromQueue(requestId: number, settling: ModelDownloadWaiter) {
  const outcome: ModelDownloadOutcome = await settling.settled
  if (currentDownloadRequest.value?.id !== requestId || waiter !== settling) return
  if (outcome.status === 'done') {
    dialogStore.downloadCompleted()
    return
  }
  if (outcome.status === 'cancelled') {
    dialogStore.downloadFailed(createCancellation({ technicalMessage: 'Download cancelled' }))
    dialogStore.closeDownloadDialog()
    return
  }
  hashError.value = true
  downloadErrorRetryable.value = outcome.detail?.retryable === true
  errorText.value = downloadErrorText(outcome.detail)
  const failure = { type: 'error', error: errorText.value }
  // A resumable error is only final once the user closes instead of retrying.
  if (downloadErrorRetryable.value) dialogStore.downloadFailedResumable(failure)
  else dialogStore.downloadFailed(failure)
}

function download(list: DownloadModelParam[]) {
  const request = currentDownloadRequest.value
  if (!request || !group.value) return
  stopHolding()
  // A retry after a failure waits anew; the failed waiter has settled.
  if (!waiter || hashError.value) waiter = modelDownloads().waiter(group.value)
  waiter.start(list, channelQuestionTemplates().forOther)
  void settleFromQueue(request.id, waiter)
}

function cancelConfirm() {
  stopHolding()
  waiter?.detach()
  dialogStore.downloadFailed(createCancellation({ technicalMessage: 'Download cancelled by user' }))
  dialogStore.closeDownloadDialog()
}

function confirmDownload() {
  const accepted = accessibleModels()
  if (currentDownloadRequest.value?.options.mode === 'ask') {
    dialogStore.downloadConfirmed(accepted)
    return
  }
  showConfirm.value = false
  download(accepted)
  dialogStore.downloadConfirmed(accepted)
}

function retryDownload() {
  etaEstimator.reset()
  download(accessibleModels())
  hashError.value = false
  downloadErrorRetryable.value = false
  errorText.value = ''
}

/** Ends the Model Downloads this dialog shows, for everyone waiting on them, as the card does. */
function cancelDownload() {
  for (const download of waiter?.downloads() ?? []) modelDownloads().cancel(download.id)
}

function close() {
  dialogStore.closeDownloadDialog()
}
</script>

<style scoped>
table {
  border-collapse: separate;
  border-spacing: 10px;
}
</style>
