<template>
  <section
    v-if="wait"
    role="region"
    :aria-label="i18nState.MODEL_DOWNLOAD_CARD_TITLE"
    class="w-full max-w-3xl flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3"
  >
    <div class="flex items-center gap-3">
      <ArrowDownTrayIcon class="size-5 flex-none text-primary" aria-hidden="true" />
      <p class="flex-1 min-w-0 font-medium">
        {{
          wait.status === 'queued'
            ? i18nState.MODEL_DOWNLOAD_QUEUED
            : i18nState.MODEL_DOWNLOAD_CARD_TITLE
        }}
      </p>
      <Button variant="secondary" size="sm" class="h-7 px-2 text-xs" @click="cancel">
        {{ i18nState.COM_CANCEL }}
      </Button>
    </div>
    <p class="text-sm text-muted-foreground truncate">
      {{ modelNames }}<template v-if="totalSize"> · {{ totalSize }}</template>
    </p>
    <Progress
      :model-value="percent"
      :aria-label="i18nState.MODEL_DOWNLOAD_CARD_TITLE"
      class="h-1.5"
    />
    <p class="text-xs text-muted-foreground">
      <template v-if="wait.status === 'downloading'">
        {{ Math.floor(percent) }}%<template v-if="wait.progress?.speed">
          · {{ wait.progress.speed }}</template
        >
        ·
      </template>
      {{ i18nState.MODEL_DOWNLOAD_CARD_CONTINUES }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDownTrayIcon } from '@heroicons/vue/24/outline'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useErrors } from '@/assets/js/store/errors'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { modelDownloads, modelKey } from '@/assets/js/models/modelDownloadQueue'
import { downloadPercent } from '@/lib/downloadPercent'
import { fetchModelMeta } from '@/lib/modelDownloader'
import { sumHumanSizes } from '@/lib/humanSize'

const props = defineProps<{ group: string }>()

const i18nState = useI18N().state
const globalSetup = useGlobalSetup()
const models = useModels()
const errors = useErrors()

const wait = computed(() => modelDownloads().snapshot(props.group))
const percent = computed(() => downloadPercent(wait.value?.progress ?? null))
const modelNames = computed(
  () => wait.value?.models.map((model) => model.repo_id.split('/').at(-1)).join(', ') ?? '',
)

const totalSize = ref('')
const sizedFor = computed(() => wait.value?.models.map(modelKey).join(',') ?? '')
watch(
  sizedFor,
  async (key) => {
    totalSize.value = ''
    const list = wait.value?.models ?? []
    if (!key || list.length === 0) return
    try {
      const meta = await fetchModelMeta(list, {
        apiHost: globalSetup.apiHost,
        hfToken: models.hfToken,
      })
      if (sizedFor.value === key) totalSize.value = sumHumanSizes(meta.map((m) => m.size)) ?? ''
    } catch (error) {
      errors.report(error, { surface: 'silent' })
    }
  },
  { immediate: true },
)

/** Ends the Model Downloads this card waits on for every turn waiting on them. */
function cancel() {
  for (const id of wait.value?.downloadIds ?? []) modelDownloads().cancel(id)
}
</script>
