<script setup lang="ts">
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const props = defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  array: Record<string, any>[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  valueKey: string
  displayKey: string
  emptyText?: string
  disabled?: boolean
}>()
</script>

<template>
  <Select>
    <SelectTrigger>
      <SelectValue :placeholder="emptyText" />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectLabel>Fruits</SelectLabel>
        <SelectItem value="apple">
          Apple
        </SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>