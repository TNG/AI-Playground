<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- Filter tabs -->
    <div class="flex gap-1 mb-3 pr-3 shrink-0">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        @click="filterTab = tab.value"
        class="flex-1 py-1 rounded text-xs font-medium transition-colors"
        :class="
          filterTab === tab.value
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:bg-muted/80'
        "
      >
        {{ tab.label }}
      </button>
    </div>
    <div class="flex flex-col space-y-2 pr-3 flex-1 overflow-y-auto">
    <div
      v-for="key in filteredConversationKeys"
      :key="key"
      class="flex flex-col items-center justify-between rounded-lg px-3 py-1 transition cursor-pointer border-2"
      :class="
        conversations.activeKey === key
          ? 'border-primary bg-muted hover:bg-muted/80'
          : 'border-transparent bg-muted hover:bg-muted/80'
      "
      @click="selectConversation(key)"
    >
      <div class="flex items-center justify-between w-full">
        <span class="truncate text-sm text-foreground">
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
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
import { useConversations } from '@/assets/js/store/conversations'
import { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'

const conversations = useConversations()
const emits = defineEmits<{
  (e: 'conversationSelected'): void
}>()

type FilterTab = 'all' | 'chat' | 'homeAgent'

const tabs: { value: FilterTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'chat', label: 'Chat' },
  { value: 'homeAgent', label: 'Home Agent' },
]

const filterTab = ref<FilterTab>('all')

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

const reversedConversationKeys = computed(() => {
  const list = conversations.conversationList ?? {}
  const keys = Object.keys(list).reverse()
  console.log('Reversed conversation keys:', list, keys)
  return keys
})

const filteredConversationKeys = computed(() => {
  if (filterTab.value === 'all') return reversedConversationKeys.value
  return reversedConversationKeys.value.filter((key) => {
    const isAgent = conversations.isHomeAgentConversation(key)
    return filterTab.value === 'homeAgent' ? isAgent : !isAgent
  })
})

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
  console.log('Selected conversation:', key)
  emits('conversationSelected')
}
</script>

<style scoped></style>
