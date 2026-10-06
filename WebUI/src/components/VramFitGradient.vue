<script setup lang="ts">
// The green-to-yellow stroke the size filter wears when it is on: the two
// verdicts it keeps, in the order it keeps them. An SVG gradient cannot be
// expressed as a colour class, so it is defined once here and referenced by id —
// `url(#…)` resolves across the document, so the icon it paints is a different
// SVG element entirely. Rendered next to each capability row that offers the
// filter; two copies of an identical def are harmless (the first one wins).
//
// Hex rather than a CSS variable so the two stops are provably the same green
// and yellow as the chip's `text-green-500` / `text-yellow-500`.
</script>

<template>
  <svg aria-hidden="true" focusable="false" class="pointer-events-none absolute size-0">
    <defs>
      <linearGradient id="vram-fit-filter-gradient" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stop-color="#22c55e" />
        <stop offset="100%" stop-color="#eab308" />
      </linearGradient>
    </defs>
  </svg>
</template>
