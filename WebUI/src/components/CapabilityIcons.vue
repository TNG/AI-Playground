<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import {
  CAPABILITIES,
  capabilityState,
  type CapabilityDescriptor,
  type CapabilityFlags,
  type CapabilityKey,
  type CapabilityState,
} from '@/assets/js/capabilities'

/** A toggle that sits in the capability filter row without being a capability. */
export type ExtraFilter = {
  key: string
  label: string
  icon: Component
  active: boolean
  /** Second tooltip line, already phrased for the current state. */
  hint: string
}

const props = withDefaults(
  defineProps<{
    /** Model whose capabilities are shown (display mode). Ignored in filter mode. */
    model?: CapabilityFlags | null
    /**
     * 'display' greys out capabilities the model lacks.
     * 'filter' renders toggle buttons; selected keys highlight and emit `toggle`.
     */
    mode?: 'display' | 'filter'
    /** Currently-active filter keys (filter mode only). */
    activeKeys?: Set<CapabilityKey>
    /**
     * Filters that are not a capability of the model but belong in the same row —
     * the VRAM fit verdict, which is computed rather than declared. Filter mode
     * only: display mode shows what a model *is*, and these are not that.
     */
    extras?: ExtraFilter[]
    iconSize?: string
    delayDuration?: number
  }>(),
  {
    model: null,
    mode: 'display',
    extras: () => [],
    iconSize: 'size-4',
    delayDuration: 100,
  },
)

const emit = defineEmits<{
  (e: 'toggle', key: CapabilityKey): void
  (e: 'toggleExtra', key: string): void
}>()

function stateOf(cap: CapabilityDescriptor): CapabilityState {
  return capabilityState(props.model, cap.flag)
}

// The three states are carried by ink, not color: confirmed is the theme's
// normal foreground, a confirmed lack and an unknown are grey — the unknown
// one additionally wears a question-mark badge so it cannot be mistaken for
// a plain "no".
const stateClasses: Record<CapabilityState, string> = {
  yes: 'text-foreground opacity-100',
  no: 'text-muted-foreground opacity-100',
  unknown: 'text-muted-foreground opacity-100',
}

function stateTooltip(cap: CapabilityDescriptor): string {
  const state = stateOf(cap)
  if (state === 'yes') return cap.tooltip
  if (state === 'no')
    return cap.lacksTooltip ?? `This model does not support ${cap.label.toLowerCase()}.`
  return cap.unknownTooltip ?? `Unknown whether this model supports ${cap.label.toLowerCase()}.`
}

function isActive(key: CapabilityKey): boolean {
  return props.activeKeys?.has(key) === true
}

// The two kinds of toggle differ only in where their state comes from, so they
// are normalised to one shape and rendered by one loop — the row cannot drift
// into two styles that way.
const toggles = computed(() => [
  ...CAPABILITIES.map((cap) => ({
    key: cap.key as string,
    label: cap.label,
    icon: cap.icon,
    active: isActive(cap.key),
    hint: isActive(cap.key)
      ? 'Filtering to models with this capability'
      : 'Show only models with this capability',
    extra: false,
  })),
  ...props.extras.map((extra) => ({ ...extra, extra: true })),
])
</script>

<template>
  <TooltipProvider>
    <!-- Display mode shows what the model is, so it lists the capabilities only.
         Filter mode lists every toggle, extras included, through one branch —
         same element, same classes, same hit area. -->
    <div v-if="mode === 'filter'" class="flex items-center gap-0.5">
      <Tooltip v-for="toggle in toggles" :key="toggle.key" :delay-duration="delayDuration">
        <TooltipTrigger as-child>
          <button
            type="button"
            :aria-pressed="toggle.active"
            :aria-label="toggle.label"
            class="flex items-center justify-center rounded p-0.5 transition-opacity"
            :class="
              toggle.active
                ? 'text-primary opacity-100'
                : 'text-muted-foreground opacity-40 hover:opacity-100 cursor-pointer'
            "
            @click="
              toggle.extra
                ? emit('toggleExtra', toggle.key)
                : emit('toggle', toggle.key as CapabilityKey)
            "
          >
            <component :is="toggle.icon" :class="iconSize" />
          </button>
        </TooltipTrigger>
        <TooltipContent class="w-56 bg-card border border-border text-foreground p-2 z-[200]">
          <p class="text-xs font-semibold">{{ toggle.label }}</p>
          <p class="text-xs text-muted-foreground">{{ toggle.hint }}</p>
        </TooltipContent>
      </Tooltip>
    </div>
    <div v-else class="flex items-center gap-0.5">
      <Tooltip v-for="cap in CAPABILITIES" :key="cap.key" :delay-duration="delayDuration">
        <TooltipTrigger as-child>
          <span
            :aria-label="cap.label"
            class="relative flex items-center justify-center rounded p-0.5 transition-opacity"
            :class="stateClasses[stateOf(cap)]"
          >
            <component :is="cap.icon" :class="iconSize" />
            <!-- Notification-style badge: the ? is font-drawn inside a solid
                 circle, so it stays crisp at this size, and the circle sits
                 mostly outside the glyph's corner. -->
            <span
              v-if="stateOf(cap) === 'unknown'"
              aria-hidden="true"
              class="absolute -top-1 -right-1 flex size-3 items-center justify-center rounded-full border border-muted-foreground text-[10px] font-bold leading-none text-muted-foreground"
              >?</span
            >
          </span>
        </TooltipTrigger>
        <TooltipContent class="w-56 bg-card border border-border text-foreground p-2 z-[200]">
          <p class="text-xs font-semibold">{{ cap.label }}</p>
          <p class="text-xs text-muted-foreground">
            {{ stateTooltip(cap) }}
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
</template>
