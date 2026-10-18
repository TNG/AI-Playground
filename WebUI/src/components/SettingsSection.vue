<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronRightIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

const props = defineProps<{
  title: string
  /** What the section is set to, shown in its header so a collapsed one still says. */
  summary?: string
  /** A setting inside needs fixing: the section opens and its header is marked. */
  attention?: boolean
}>()

const open = ref(props.attention === true)

watch(
  () => props.attention,
  (attention) => {
    if (attention) open.value = true
  },
)
</script>

<template>
  <Collapsible v-model:open="open" class="flex flex-col rounded-md border border-border">
    <CollapsibleTrigger
      class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 rounded-md"
    >
      <ChevronRightIcon
        class="size-4 flex-none text-muted-foreground transition-transform"
        :class="{ 'rotate-90': open }"
      />
      <span class="text-sm font-semibold text-foreground whitespace-nowrap">{{ title }}</span>
      <ExclamationTriangleIcon v-if="attention" class="size-4 flex-none text-amber-500" />
      <span v-if="summary" class="ml-auto min-w-0 truncate text-xs text-muted-foreground">
        {{ summary }}
      </span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="flex flex-col gap-4 border-t border-border p-3">
        <slot />
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
