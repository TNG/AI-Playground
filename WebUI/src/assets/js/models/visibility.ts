// The shared "hide from picker" predicate.
//
// Hiding a model is a *presentation* preference, so it must never reach model
// resolution: `textInference.llmModels` also backs `activeModel`, the capability
// computeds and the download-param derivation, and filtering it would break the
// next chat turn the moment a user hides the selected model. Instead `hidden`
// travels as a field and every picker filters through the functions here, which
// always keep the current selection.
//
// The same rule protects generation: a hidden model a preset requires stays
// available for that preset, otherwise hiding would silently break image/video
// runs.

export type HideableModel = {
  name: string
  hidden?: boolean
  favorite?: boolean
}

export type PreferenceFlags = {
  hidden: boolean
  favorite: boolean
}

/**
 * Attach the user's `hidden`/`favorite` flags to a list of models.
 *
 * The flags are looked up here, at the point the list is derived, instead of
 * being stored on the catalog snapshot: a snapshot is only rebuilt by a catalog
 * refresh, so a flag written into one goes stale the moment the user toggles a
 * preference and the pickers keep showing the old value. Called from a computed
 * with a lookup that reads the preferences ref, the flags re-resolve on every
 * write with no refresh involved.
 */
export function withPreferenceFlags<T extends { name: string }>(
  models: readonly T[],
  flagsFor: (model: T) => PreferenceFlags,
): (T & PreferenceFlags)[] {
  return models.map((model) => ({ ...model, ...flagsFor(model) }))
}

export type VisibilityOptions = {
  /** Never hide the current selection — it would strand it with no way back. */
  selected?: string | null
  /** Never hide a model the active preset needs (e.g. ComfyUI `requiredModels`). */
  required?: readonly string[]
  /** Show hidden models anyway (the management view's "Show hidden" toggle). */
  includeHidden?: boolean
}

function isProtected(name: string, options: VisibilityOptions): boolean {
  if (options.selected && options.selected === name) return true
  return options.required?.includes(name) === true
}

/** Whether a model should appear in a picker. */
export function isVisibleInPicker<T extends HideableModel>(
  model: T,
  options: VisibilityOptions = {},
): boolean {
  if (options.includeHidden) return true
  if (!model.hidden) return true
  return isProtected(model.name, options)
}

/** Drop hidden models, keeping the selection and any preset-required models. */
export function filterVisibleModels<T extends HideableModel>(
  models: readonly T[],
  options: VisibilityOptions = {},
): T[] {
  return models.filter((model) => isVisibleInPicker(model, options))
}

/**
 * Favorites first, otherwise the incoming order (which for the chat catalog is
 * `models.json` priority order and must be preserved).
 */
export function sortFavoritesFirst<T extends HideableModel>(models: readonly T[]): T[] {
  const favorites = models.filter((model) => model.favorite === true)
  const rest = models.filter((model) => model.favorite !== true)
  return [...favorites, ...rest]
}

/**
 * Plain string lists need the same treatment: the ComfyUI model dropdowns work on
 * file names, not model objects. `isHidden` is passed in so name normalisation
 * (on-disk `owner---repo\file` vs catalog `owner/repo/file`) stays in one place,
 * and `keep` lists the names that must survive regardless — a preset's required
 * models and whatever is currently selected.
 */
export function filterVisibleNames(
  names: readonly string[],
  isHidden: (name: string) => boolean,
  keep: readonly string[] = [],
): string[] {
  return names.filter((name) => !isHidden(name) || keep.includes(name))
}
