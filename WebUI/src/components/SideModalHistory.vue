<template>
  <SideModalBase
    :is-visible="isVisible"
    :title="
      mode === 'agent' ? languages.COM_SESSIONS : `${mapModeToLabel(mode)} ${languages.COM_HISTORY}`
    "
    side="left"
    @close="$emit('close')"
  >
    <template #header-buttons>
      <!-- Clear-all is a delete-all-IMAGES action — only offered for the
           workflow modes it applies to (not chat/audio, not agent sessions). -->
      <AlertDialog v-if="isWorkflowMode">
        <AlertDialogTrigger asChild>
          <button class="svg-icon i-clear w-6 h-6" :title="languages.COM_CLEAR_HISTORY" />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{ languages.COM_DELETE_ALL_IMAGES_QUESTION }}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {{ languages.COM_DELETE_ALL_IMAGES_EXPLANATION }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction @click="deleteAllImages">
              {{ languages.COM_DELETE }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <button
        v-show="isChatLikeMode && chatFilterKind !== 'homeAgent'"
        @click="selectNewConversation"
        class="svg-icon i-add w-7 h-7"
        :title="languages.COM_ADD"
      />
      <button
        v-show="isWorkflowMode"
        @click="selectNewMedia"
        class="svg-icon i-add w-7 h-7"
        :title="languages.COM_ADD"
      />
      <!-- "New" follows the preset: a new game (own folder) under Game Agent, a
           new conversation in the same workspace otherwise. -->
      <button
        v-show="mode === 'agent'"
        @click="agentMode.startNew()"
        class="svg-icon i-add w-7 h-7"
        :title="agentMode.agentWorkspaceKind === 'games' ? 'New game' : languages.COM_ADD"
      />
    </template>

    <!-- Audio turns (synthesized audio, transcripts) are chat conversations too. -->
    <HistoryChat
      v-if="isChatLikeMode"
      @conversation-selected="emit('conversationSelected')"
      @filter-kind-change="(kind) => (chatFilterKind = kind)"
    />
    <HistoryWorkflow v-else-if="props.mode === 'imageGen'" mode="imageGen" />
    <HistoryWorkflow v-else-if="props.mode === 'imageEdit'" mode="imageEdit" />
    <HistoryWorkflow v-else-if="props.mode === 'video'" mode="video" />
    <HistoryAgentSessions v-else-if="props.mode === 'agent'" />
  </SideModalBase>
</template>

<script setup lang="ts">
import HistoryChat from '@/components/HistoryChat.vue'
import HistoryWorkflow from '@/components/HistoryWorkflow.vue'
import HistoryAgentSessions from '@/components/HistoryAgentSessions.vue'
import { computed, ref } from 'vue'
import { useConversations, type ThreadKind } from '@/assets/js/store/conversations.ts'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { mapModeToLabel } from '@/lib/utils.ts'
import SideModalBase from '@/components/SideModalBase.vue'
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

const conversations = useConversations()
const imageGeneration = useImageGenerationPresets()
const agentMode = useAgentMode()

const chatFilterKind = ref<ThreadKind>('main')

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'conversationSelected'): void
}>()

const workflowModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
const isWorkflowMode = computed(() => workflowModes.includes(props.mode))
const isChatLikeMode = computed(() => props.mode === 'chat' || props.mode === 'audio')

function selectNewConversation() {
  const key = conversations.addNewConversation()
  if (!key) return
  conversations.activeKey = key
}

function selectNewMedia() {
  if (props.mode === 'imageGen') {
    imageGeneration.selectedGeneratedImageId = 'new'
  } else if (props.mode === 'imageEdit') {
    imageGeneration.selectedEditedImageId = 'new'
  } else if (props.mode === 'video') {
    imageGeneration.selectedVideoId = 'new'
  }
}

function deleteAllImages() {
  // Only the workflow modes have deletable image histories (never chat/audio/agent).
  if (isWorkflowMode.value) {
    imageGeneration.deleteAllImagesForMode(props.mode as WorkflowModeType)
  }
}
</script>
