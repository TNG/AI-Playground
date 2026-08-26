<template>
  <!-- The Game Agent equivalent of the image panel's result toolbar: what game is
       being worked on, and what can be done with it. Agent Mode has no results
       panel, so it lives above the transcript. -->
  <!-- Opaque, because it is pinned: the transcript scrolls underneath it. -->
  <div
    role="group"
    aria-label="Current game"
    class="flex min-w-0 max-w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-sm"
  >
    <img
      v-if="game?.iconUrl"
      :src="game.iconUrl"
      alt=""
      class="size-8 rounded object-cover border border-border"
    />
    <span v-else class="size-8 rounded bg-muted grid place-items-center text-base">🎮</span>

    <div class="flex flex-col min-w-0">
      <span class="text-sm text-foreground truncate">{{ gameName }}</span>
      <span class="text-xs text-muted-foreground truncate">{{ subtitle }}</span>
    </div>

    <div class="ml-auto flex items-center gap-2">
      <Button
        variant="secondary"
        class="px-3 py-1.5 rounded text-sm"
        :disabled="!game"
        @click="play"
      >
        Play
      </Button>
      <!-- Publishing means putting the game on the generated arcade page, which
           only Acer ships. Elsewhere a game is simply the files in its folder. -->
      <Button
        v-if="oemBranding.showsArcade"
        variant="secondary"
        class="px-3 py-1.5 rounded text-sm"
        :disabled="!game"
        @click="openSaveDialog"
      >
        {{ saveLabel }}
      </Button>
      <!-- Acer systems get the branded gallery page; everyone else opens games from
           the folder. -->
      <Button
        v-if="oemBranding.showsArcade"
        variant="secondary"
        class="px-3 py-1.5 rounded text-sm"
        @click="openArcade"
      >
        Open {{ oemBranding.arcadeLabel }}
      </Button>
      <IconButton
        icon="i-folder"
        :tooltip="game ? 'Open the game folder' : 'Open the game library folder'"
        @click="openFolder"
      />
    </div>
  </div>

  <Dialog v-model:open="saveDialogOpen">
    <DialogContent class="sm:max-w-[425px]">
      <DialogHeader>
        <DialogTitle>{{ saveLabel }}</DialogTitle>
        <DialogDescription>
          Games you add show up in your {{ oemBranding.arcadeLabel }}, alongside the files in your
          game folder.
        </DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-4 py-2">
        <div class="flex flex-col gap-2">
          <Label for="game-name">Name</Label>
          <Input id="game-name" v-model="draftName" placeholder="Space Dodger" />
        </div>
        <div class="flex flex-col gap-2">
          <Label for="game-description">Description</Label>
          <Textarea
            id="game-description"
            v-model="draftDescription"
            rows="3"
            placeholder="Dodge asteroids for as long as you can."
          />
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" @click="saveDialogOpen = false">Cancel</Button>
        <Button :disabled="saving || !draftName.trim()" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import IconButton from '@/components/ui/IconButton.vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import * as toast from '@/assets/js/toast'

const agentMode = useAgentMode()
const oemBranding = useOemBranding()

const game = computed(() => agentMode.currentGame)

const gameName = computed(() => game.value?.name ?? 'New game')

const subtitle = computed(() => {
  if (!game.value) return 'Describe the game you want and the agent starts building'
  if (game.value.description) return game.value.description
  if (!oemBranding.showsArcade) return 'Saved in your games folder'
  return game.value.published
    ? `In your ${oemBranding.arcadeTarget}`
    : `Draft — not added to the ${oemBranding.arcadeTarget} yet`
})

const saveLabel = computed(() =>
  game.value?.published
    ? `Update in ${oemBranding.arcadeTarget}`
    : `Add to ${oemBranding.arcadeTarget}`,
)

const saveDialogOpen = ref(false)
const draftName = ref('')
const draftDescription = ref('')
const saving = ref(false)

function openSaveDialog(): void {
  // Prefilled from what the agent already wrote into game.json, so the usual case
  // is confirming rather than typing.
  draftName.value = game.value?.name ?? ''
  draftDescription.value = game.value?.description ?? ''
  saveDialogOpen.value = true
}

async function save(): Promise<void> {
  const dir = game.value?.dir
  if (!dir) return
  saving.value = true
  try {
    const result = await window.electronAPI.games.publish(dir, {
      name: draftName.value,
      description: draftDescription.value,
    })
    if (!result.success) {
      toast.error(result.error ?? 'Could not save the game.')
      return
    }
    saveDialogOpen.value = false
    await agentMode.refreshCurrentGame()
    toast.success(`${draftName.value.trim()} is in your ${oemBranding.arcadeTarget}.`)
  } finally {
    saving.value = false
  }
}

async function play(): Promise<void> {
  const dir = game.value?.dir
  if (!dir) return
  const result = await window.electronAPI.games.play(dir)
  if (!result.success) toast.error(result.error ?? 'Could not open the game.')
}

async function openFolder(): Promise<void> {
  await window.electronAPI.games.openFolder(game.value?.dir)
}

async function openArcade(): Promise<void> {
  const result = await window.electronAPI.games.openArcade()
  if (!result.success) toast.error(result.error ?? 'Could not open the arcade.')
}
</script>
