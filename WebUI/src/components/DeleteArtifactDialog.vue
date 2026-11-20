<template>
  <AlertDialog :open="open" @update:open="(value) => emit('update:open', value)">
    <AlertDialogContent @click.stop>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ languages.ARTIFACT_DELETE_TITLE }}</AlertDialogTitle>
        <AlertDialogDescription>{{ languages.ARTIFACT_DELETE_BODY }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click.stop>{{ languages.COM_CANCEL }}</AlertDialogCancel>
        <!-- Not AlertDialogAction: it closes before our click runs, and a caller's close clears its target. -->
        <Button @click.stop="confirm">
          {{ languages.COM_DELETE }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

defineProps<{ open: boolean }>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  confirm: []
}>()

const languages = useI18N().state

function confirm(): void {
  emit('confirm')
  emit('update:open', false)
}
</script>
