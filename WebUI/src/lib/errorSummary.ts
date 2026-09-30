export function errorSummary(
  details: ErrorDetails | null | undefined,
  withDetails: string,
  withoutDetails: string,
): string {
  return details?.hint ?? (details ? withDetails : withoutDetails)
}
