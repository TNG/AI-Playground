<template>
  <TooltipProvider :delay-duration="200">
    <div class="flex flex-col space-y-2 pr-3 h-full overflow-y-auto">
      <!-- The Local / Home Agent split lives inside the Assistant's own list. The
           Audio list is a mode of its own, so it is locked to its kind. -->
      <div v-if="!props.lockedKind" class="flex items-center justify-center gap-2 px-1 pb-1">
        <span
          class="text-xs font-medium select-none"
          :class="filterKind === 'main' ? 'text-foreground' : 'text-muted-foreground'"
        >
          Local
        </span>
        <Switch
          :model-value="filterKind === 'homeAgent'"
          aria-label="Toggle between Local and Home Agent conversations"
          @update:model-value="(checked: boolean) => switchKind(checked ? 'homeAgent' : 'main')"
        />
        <span
          class="text-xs font-medium select-none"
          :class="filterKind === 'homeAgent' ? 'text-foreground' : 'text-muted-foreground'"
        >
          Home Agent
        </span>
      </div>
      <div
        v-if="reversedConversationKeys.length === 0"
        class="px-2 py-4 text-xs text-muted-foreground italic"
      >
        {{ emptyMessage }}
      </div>
      <div
        v-for="key in reversedConversationKeys"
        :key="key"
        class="flex flex-col items-center justify-between rounded-lg px-3 py-1 transition cursor-pointer border-2"
        :class="
          conversations.activeKey === key
            ? 'border-primary bg-muted hover:bg-muted/80'
            : 'border-transparent bg-muted hover:bg-muted/80'
        "
        @click="selectConversation(key)"
      >
        <div class="flex items-center justify-between w-full gap-1.5">
          <!-- Text to Speech and Speech to Text share the Audio list, so the preset
               that held a thread is what tells its rows apart. -->
          <Tooltip v-if="threadPresets[key]">
            <TooltipTrigger as-child>
              <span class="inline-flex flex-none cursor-help" :aria-label="threadPresets[key].name">
                <img
                  v-if="threadPresets[key].image"
                  :src="threadPresets[key].image"
                  :alt="threadPresets[key].name"
                  class="size-5 rounded object-cover border border-border"
                />
                <span
                  v-else
                  class="size-5 rounded border border-border bg-muted grid place-items-center text-[10px] font-medium"
                >
                  {{ threadPresets[key].name.slice(0, 1) }}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{{ threadPresets[key].name }}</TooltipContent>
          </Tooltip>
          <span class="truncate text-sm text-foreground mr-auto">
            {{ conversationTitle(key) }}
          </span>
          <DropdownMenu
            :open="menuOpenKey === key"
            @update:open="(open) => onMenuOpenChange(key, open)"
          >
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon" class="h-6 w-6" @click.stop>
                <span class="svg-icon i-dots-vertical w-4 h-4"></span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              class="w-28"
              :onCloseAutoFocus="
                (ev) => {
                  ev.preventDefault?.()
                }
              "
            >
              <Dialog
                v-model:open="renameDialogOpen"
                @update:open="
                  (open) => {
                    if (!open) menuOpenKey = null
                  }
                "
              >
                <DialogTrigger asChild>
                  <DropdownMenuItem
                    @select="
                      (e: Event) => {
                        e.preventDefault()
                        openRenameDialog(key)
                      }
                    "
                  >
                    Rename
                  </DropdownMenuItem>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rename conversation</DialogTitle>
                    <DialogDescription>Set a new title for this conversation.</DialogDescription>
                  </DialogHeader>
                  <div class="mt-2">
                    <Input
                      autofocus
                      type="text"
                      placeholder="Enter title"
                      v-model="renameTitle"
                      @keydown.enter.prevent="saveRename"
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" @click="cancelRename">Cancel</Button>
                    <Button :disabled="!renameTitle.trim()" @click="saveRename">Save</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <DropdownMenuItem @select="(e: Event) => e.preventDefault()">
                    Delete
                  </DropdownMenuItem>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently remove this conversation and its messages.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction @click="() => conversations.deleteConversation(key)">
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ThumbnailPreviewStrip :items="images(conversations.conversationList[key])" />
      </div>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ThumbnailPreviewStrip from './ThumbnailPreviewStrip.vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversations, type ThreadKind } from '@/assets/js/store/conversations'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { usePresets } from '@/assets/js/store/presets'
import { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'

const conversations = useConversations()
const homeAgent = useHomeAgent()
const presetsStore = usePresets()

/**
 * The list this panel shows, when the mode owns one kind of conversation
 * outright: Audio does, the Assistant's Local / Home Agent split does not.
 */
const props = defineProps<{
  lockedKind?: ThreadKind
}>()

const emits = defineEmits<{
  (e: 'conversationSelected'): void
  (e: 'filterKindChange', kind: ThreadKind): void
}>()

const images = (conversation: AipgUiMessage[]) => {
  return conversation.flatMap((msg, msgIndex) =>
    msg.parts
      .filter(
        (part) =>
          (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') &&
          part.state === 'output-available',
      )
      .map((part, partIndex) => {
        if (
          (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') &&
          'output' in part &&
          part.output &&
          typeof part.output === 'object' &&
          'images' in part.output
        ) {
          const images = (part.output as { images?: Array<{ imageUrl?: string }> }).images ?? []
          return images.map((img, imgIndex) => ({
            id: `${msgIndex}-${partIndex}-${imgIndex}`,
            imageUrl: img.imageUrl ?? '',
          }))
        }
        return []
      })
      .flat()
      .filter(
        (img): img is { id: string; imageUrl: string } =>
          img !== null &&
          img !== undefined &&
          'imageUrl' in img &&
          typeof img.imageUrl === 'string' &&
          img.imageUrl.trim() !== '' &&
          'id' in img &&
          typeof img.id === 'string',
      ),
  )
}

// Local UI filter: Home Agent vs. Local (main) threads. Initialized from the
// kind of the currently active conversation so the switch reflects whatever
// state the rest of the app left us in (e.g. Telegram poll just moved
// activeKey onto a Home Agent thread). Kept in sync with external activeKey
// changes via the watcher below. A locked list has no filter to track.
function filterFor(conversationKey: string): ThreadKind {
  if (props.lockedKind) return props.lockedKind
  const kind = conversations.getThreadKind(conversationKey)
  // Only this panel's own two kinds can be filtered to; an Audio thread has no
  // row here, so showing its (empty) list would be a dead end.
  return kind === 'homeAgent' ? 'homeAgent' : 'main'
}

const filterKind = ref<ThreadKind>(filterFor(conversations.activeKey))

watch(filterKind, (kind) => emits('filterKindChange', kind), { immediate: true })

watch(
  () => conversations.activeKey,
  (k) => {
    if (!k) return
    filterKind.value = filterFor(k)
  },
)

const reversedConversationKeys = computed(() => {
  const list = conversations.conversationList ?? {}
  return Object.keys(list)
    .filter((k) => conversations.getThreadKind(k) === filterKind.value)
    .reverse()
})

const emptyMessage = computed(() => {
  if (filterKind.value === 'audio') return 'No audio conversations yet.'
  if (filterKind.value === 'homeAgent') return 'No Home Agent conversations yet.'
  return 'No local conversations yet.'
})

/**
 * The preset each listed thread was last held with, resolved once per render
 * rather than per row element.
 */
const threadPresets = computed(() => {
  const byKey: Record<string, { name: string; image?: string }> = {}
  for (const key of reversedConversationKeys.value) {
    const presetName = conversations.getThreadMeta(key)?.presetName
    if (!presetName) continue
    const preset = presetsStore.presets.find((p) => p.name === presetName)
    byKey[key] = { name: presetName, image: preset?.image }
  }
  return byKey
})

// Pick the target conversation when the user flips the switch:
//   • Home Agent → last routed remote thread (Telegram /load / desktop click),
//     else the newest remote key, else just flip the filter (empty list).
//   • Main → tracked `lastMainKey`, else newest main key, else allocate a new
//     main bucket so the user always has somewhere to type.
function switchKind(kind: ThreadKind) {
  if (kind === filterKind.value) return

  // Flip the filter up-front so the switch always reflects the user's choice,
  // even when the resolved target key equals the current activeKey (in which
  // case the activeKey watcher would not fire).
  filterKind.value = kind

  if (kind === 'homeAgent') {
    const list = conversations.conversationList
    const stored = homeAgent.activeRemoteConversationKey
    if (stored && list[stored] && conversations.getThreadKind(stored) === 'homeAgent') {
      conversations.activeKey = stored
      return
    }
    const remoteKeys = homeAgent.remoteConversationKeys
    if (remoteKeys.length > 0) {
      const newest = [...remoteKeys].sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0))[0]
      conversations.activeKey = newest
      return
    }
    // No remote threads exist yet — keep activeKey on the current main thread
    // so the chat view stays usable; the filter was already flipped above so
    // the empty-state hint shows for Home Agent.
    return
  }

  // kind === 'main'
  const list = conversations.conversationList
  const stored = conversations.lastMainKey
  if (stored && list[stored] && conversations.getThreadKind(stored) === 'main') {
    conversations.activeKey = stored
    return
  }
  const mainKeys = Object.keys(list).filter((k) => conversations.getThreadKind(k) === 'main')
  if (mainKeys.length > 0) {
    const newest = mainKeys.sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0))[0]
    conversations.activeKey = newest
    return
  }
  conversations.addNewConversation()
}

const conversationTitle = (key: string) => {
  const conversation = conversations.conversationList[key]
  if (!conversation || conversation.length === 0) {
    return 'New Conversation'
  }
  if (conversation[0].metadata?.conversationTitle) {
    return conversation[0].metadata.conversationTitle
  }
  const firstMessage = conversation[0]

  // todo: can be deleted eventually
  if (firstMessage.parts === undefined) {
    conversations.deleteConversation(key)
  }

  const titlePart = firstMessage.parts?.find((part) => part.type === 'text')
  return titlePart ? titlePart.text.substring(0, 50) : 'New Conversation'
}

const menuOpenKey = ref<string | null>(null)

function onMenuOpenChange(conversationKey: string, open: boolean) {
  menuOpenKey.value = open
    ? conversationKey
    : menuOpenKey.value === conversationKey
      ? null
      : menuOpenKey.value
}

// Rename dialog state
const renameDialogOpen = ref(false)
const renameKey = ref<string | null>(null)
const renameTitle = ref('')

function openRenameDialog(conversationKey: string) {
  renameKey.value = conversationKey
  const existingTitle = conversationTitle(conversationKey)
  renameTitle.value = existingTitle ?? ''
  renameDialogOpen.value = true
}

function cancelRename() {
  renameDialogOpen.value = false
  renameKey.value = null
  menuOpenKey.value = null
}

function saveRename() {
  if (!renameKey.value) return
  const newTitle = renameTitle.value.trim()
  if (newTitle.length === 0) return
  conversations.renameConversationTitle(renameKey.value, newTitle)
  renameDialogOpen.value = false
  menuOpenKey.value = null
  renameKey.value = null
}

const selectConversation = (key: string) => {
  conversations.activeKey = key
  emits('conversationSelected')
}
</script>

<style scoped></style>
