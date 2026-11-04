import { computed, onBeforeUnmount, ref, watch, type Ref, type StyleValue } from 'vue'

/** Marks the box a Result's artifacts may widen to: its content box, inside its padding. */
export const ARTIFACT_BREAKOUT_ATTRIBUTE = 'data-artifact-breakout'

type Breakout = { offset?: number; width: number }

/**
 * Lets a block nested in the reading column span the nearest breakout box, and reports the
 * width it then has. Without such a box it keeps its own place and width.
 */
export function useArtifactBreakout(anchor: Ref<HTMLElement | null>) {
  const box = ref<Breakout | null>(null)
  let observer: ResizeObserver | undefined

  function measure() {
    const el = anchor.value
    if (!el) return
    const container = el.parentElement?.closest<HTMLElement>(`[${ARTIFACT_BREAKOUT_ATTRIBUTE}]`)
    if (!container) {
      update({ width: el.clientWidth })
      return
    }
    const style = getComputedStyle(container)
    const paddingLeft = parseFloat(style.paddingLeft) || 0
    const paddingRight = parseFloat(style.paddingRight) || 0
    const left = container.getBoundingClientRect().left + container.clientLeft + paddingLeft
    update({
      offset: el.getBoundingClientRect().left - left,
      width: Math.floor(container.clientWidth - paddingLeft - paddingRight),
    })
  }

  function update(next: Breakout) {
    if (box.value?.offset !== next.offset || box.value?.width !== next.width) box.value = next
  }

  watch(
    anchor,
    (el) => {
      observer?.disconnect()
      observer = undefined
      if (!el) return
      observer = new ResizeObserver(measure)
      observer.observe(el)
      const container = el.parentElement?.closest(`[${ARTIFACT_BREAKOUT_ATTRIBUTE}]`)
      if (container) observer.observe(container)
      measure()
    },
    { flush: 'post' },
  )

  onBeforeUnmount(() => observer?.disconnect())

  const style = computed<StyleValue>(() =>
    box.value?.offset !== undefined
      ? { marginLeft: `${-box.value.offset}px`, width: `${box.value.width}px` }
      : {},
  )
  const width = computed(() => box.value?.width ?? 0)

  return { style, width }
}
