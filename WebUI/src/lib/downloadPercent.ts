import type { ModelDownloadProgress } from '@/lib/modelDownloader'

/** Overall progress of a Model Download, 0-100: finished models plus the current file's share. */
export function downloadPercent(progress: ModelDownloadProgress | null): number {
  if (!progress || progress.total <= 0) return 0
  // The completion event repeats 100% for a model `completed` already counts.
  const current = progress.speed === undefined ? 0 : progress.percent / 100
  return Math.min(100, ((progress.completed + current) / progress.total) * 100)
}
