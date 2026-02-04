<script lang="ts" setup>
import { computed, onMounted, watch } from 'vue'
import { useTextInference } from '@/assets/js/store/textInference'
import { useModels } from '@/assets/js/store/models'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/vue/24/solid'

const textInference = useTextInference()
const models = useModels()

// Get current active model
const currentModel = computed(() => {
  const model = textInference.llmModels.find((m) => m.active && m.type === textInference.backend)
  return model
})

// Get available mmproj files for the current model
// Includes both downloaded files and predefined mmproj (if not yet downloaded)
const mmprojFiles = computed(() => {
  if (!currentModel.value) return []

  const downloadedFiles = currentModel.value.mmprojFiles || []
  const predefinedMmproj = currentModel.value.mmproj

  // Create list with download status
  const fileList: Array<{ filename: string; downloaded: boolean }> = []

  // Add all downloaded files
  downloadedFiles.forEach((file) => {
    fileList.push({ filename: file, downloaded: true })
  })

  // Add predefined mmproj if it exists and is not already in the downloaded list
  if (predefinedMmproj) {
    const mmprojFilename = predefinedMmproj.split('/').pop() || predefinedMmproj
    const alreadyInList = fileList.some((item) => item.filename === mmprojFilename)
    if (!alreadyInList) {
      fileList.push({ filename: mmprojFilename, downloaded: false })
    }
  }

  return fileList
})

// Get selected mmproj file with download status
const selectedMmprojInfo = computed(() => {
  if (!currentModel.value) return undefined
  const selected = currentModel.value.selectedMmproj
  if (!selected) return undefined

  // Find the selected mmproj in our list to get download status
  const found = mmprojFiles.value.find((item) => item.filename === selected)
  return found
})

// Handle mmproj selection
function selectMmproj(mmprojFile: string) {
  console.log('[VisionModelSelector] Selecting mmproj:', mmprojFile)
  if (!currentModel.value) return
  models.setSelectedMmproj(currentModel.value.name, mmprojFile)
}

onMounted(() => {
  console.log('[VisionModelSelector] Component MOUNTED!')
  console.log('[VisionModelSelector] Current model:', currentModel.value?.name)
  console.log('[VisionModelSelector] mmproj files:', mmprojFiles.value)
  console.log('[VisionModelSelector] Selected mmproj:', selectedMmprojInfo.value)
})

// Auto-select mmproj file if nothing is selected
watch(
  [currentModel, mmprojFiles],
  ([newModel, newFiles]) => {
    console.log('[VisionModelSelector] Data changed - Model:', newModel?.name, 'Files:', newFiles)

    // Auto-select if there's at least one mmproj option and nothing is selected yet
    if (newModel && newFiles.length > 0 && !newModel.selectedMmproj) {
      // Prefer downloaded mmproj files over non-downloaded ones
      const downloadedMmproj = newFiles.find((file) => file.downloaded)
      const mmprojToSelect = downloadedMmproj || newFiles[0]

      console.log(
        '[VisionModelSelector] Auto-selecting mmproj:',
        mmprojToSelect.filename,
        `(downloaded: ${mmprojToSelect.downloaded})`,
      )
      selectMmproj(mmprojToSelect.filename)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="w-full">
    <!-- Always show dropdown for mmproj selection - parent controls visibility -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button class="w-full">
          <div
            class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center justify-between"
          >
            <div
              class="w-2 h-2 rounded-full shrink-0"
              :class="selectedMmprojInfo?.downloaded ? 'bg-primary' : 'bg-muted-foreground'"
            ></div>
            <span class="text-xs flex-grow text-left px-3 text-nowrap">
              {{ selectedMmprojInfo?.filename || 'Select mmproj...' }}
            </span>
            <ChevronDownIcon class="size-4 text-muted-foreground"></ChevronDownIcon>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        :align="'start'"
        :align-offset="-20"
        class="w-full rounded-md p-[3px] border border-border bg-card max-h-[188px] overflow-y-auto z-[100] ml-4"
      >
        <DropdownMenuLabel class="text-foreground px-3 py-2 text-sm font-medium"
          >Vision Model (mmproj)</DropdownMenuLabel
        >
        <DropdownMenuSeparator class="bg-border" />
        <div class="py-1">
          <DropdownMenuItem
            v-for="item in mmprojFiles"
            :key="item.filename"
            @click="() => selectMmproj(item.filename)"
            class="text-sm px-4 py-1 flex items-center text-left hover:bg-muted text-foreground group"
          >
            <div class="flex items-center flex-1 min-w-0">
              <!-- Show primary color for downloaded, gray for not downloaded -->
              <div
                class="w-2 h-2 rounded-full mr-2 shrink-0"
                :class="item.downloaded ? 'bg-primary' : 'bg-muted-foreground'"
              ></div>
              <span class="flex-1 truncate">{{ item.filename }}</span>
            </div>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
