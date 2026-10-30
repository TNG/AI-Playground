import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import {
  describeSettingsProblem,
  type SessionSettingsProblem,
  type SessionSettingsProblemField,
} from '@/lib/sessionSettingsProblems'

/** How an Agent settings form marks the controls whose stored value is unusable. */
export function useSettingsProblemMarks(
  problems: MaybeRefOrGetter<readonly SessionSettingsProblem[]>,
) {
  const i18n = useI18N().state
  const fields = computed(() => new Set(toValue(problems).map((p) => p.field)))

  function problemClass(field: SessionSettingsProblemField): string {
    return fields.value.has(field) ? 'rounded-sm ring-1 ring-amber-500 p-1' : ''
  }

  function hasProblem(...candidates: SessionSettingsProblemField[]): boolean {
    return candidates.some((field) => fields.value.has(field))
  }

  const missingMcpServers = computed(() =>
    toValue(problems)
      .filter((p) => p.field === 'mcpServer')
      .map((p) => p.value),
  )

  function describeMissingMcpServer(serverId: string): string {
    return describeSettingsProblem({ field: 'mcpServer', value: serverId }, i18n)
  }

  return { problemClass, hasProblem, missingMcpServers, describeMissingMcpServer }
}
