<template>
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <span role="status" class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
      <ChatBubbleLeftEllipsisIcon class="size-3.5" aria-hidden="true" />
      {{ withChannel(languages.AGENT_HELD_ANSWER_WAITING) }}
    </span>
    <TooltipProvider :delay-duration="200">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="secondary"
            size="sm"
            class="h-6 px-2 text-xs"
            :aria-label="withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT)"
            @click="emit('discard')"
          >
            <XMarkIcon class="size-3.5" aria-hidden="true" />
            {{ languages.AGENT_HELD_ANSWER_DISCARD }}
          </Button>
        </TooltipTrigger>
        <TooltipContent class="max-w-xs">
          {{ withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT) }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import { ChatBubbleLeftEllipsisIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { fillTemplate } from '@/lib/notificationLabel'

const props = defineProps<{ channel: ChannelKind }>()

const emit = defineEmits<{ discard: [] }>()

const languages = useI18N().state

function withChannel(template: string): string {
  const name = getDescriptor(props.channel)?.displayName ?? props.channel
  return fillTemplate(template, { channel: name })
}
</script>
