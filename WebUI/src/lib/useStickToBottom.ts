import { ref, watch, type Ref } from 'vue'

const FOLLOW_THRESHOLD_PX = 35
const SHOW_BUTTON_THRESHOLD_PX = 60

/**
 * Keeps a scroll container pinned to its bottom while its content grows (streamed
 * tokens, images finishing loading, expanded blocks), until the user scrolls up.
 */
export function useStickToBottom(panel: Ref<HTMLElement | null>) {
  const following = ref(true)
  const showScrollButton = ref(false)
  let lastScrollTop = 0

  function scrollToBottom(smooth = true) {
    const el = panel.value
    if (!el) return
    following.value = true
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  function handleScroll() {
    const el = panel.value
    if (!el) return
    const scrollTop = el.scrollTop
    const distanceFromBottom = el.scrollHeight - (scrollTop + el.clientHeight)
    showScrollButton.value = distanceFromBottom > SHOW_BUTTON_THRESHOLD_PX
    // Shrinking content clamps scrollTop upwards too, but leaves it at the bottom.
    if (distanceFromBottom <= FOLLOW_THRESHOLD_PX) following.value = true
    else if (scrollTop < lastScrollTop - 1) following.value = false
    lastScrollTop = scrollTop
  }

  // Instant, not smooth: per-token smooth scrolls restart mid-animation and jitter.
  const observer = new ResizeObserver(() => {
    if (following.value) scrollToBottom(false)
    else handleScroll()
  })

  watch(
    panel,
    (el, _old, onCleanup) => {
      if (!el) return
      observer.observe(el)
      for (const child of el.children) observer.observe(child)
      const childObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) if (node instanceof Element) observer.observe(node)
          for (const node of record.removedNodes)
            if (node instanceof Element) observer.unobserve(node)
        }
      })
      childObserver.observe(el, { childList: true })
      el.addEventListener('scroll', handleScroll, { passive: true })
      onCleanup(() => {
        childObserver.disconnect()
        observer.disconnect()
        el.removeEventListener('scroll', handleScroll)
      })
    },
    { immediate: true },
  )

  return { following, showScrollButton, scrollToBottom }
}
