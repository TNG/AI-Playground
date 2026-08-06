import { describe, expect, it } from 'vitest'
import {
  filterVisibleModels,
  filterVisibleNames,
  isVisibleInPicker,
  sortFavoritesFirst,
  withPreferenceFlags,
} from './visibility'

// These cases are the two invariants the whole "hide a model" feature rests on:
// hiding must never strand the current selection, and must never break a preset
// that needs the model. Both are what stops a presentation preference from
// turning into a broken app.

const model = (name: string, extra: { hidden?: boolean; favorite?: boolean } = {}) => ({
  name,
  ...extra,
})

describe('isVisibleInPicker', () => {
  it('shows a model that is not hidden', () => {
    expect(isVisibleInPicker(model('a'))).toBe(true)
  })

  it('hides a hidden model', () => {
    expect(isVisibleInPicker(model('a', { hidden: true }))).toBe(false)
  })

  it('keeps a hidden model when it is the current selection', () => {
    expect(isVisibleInPicker(model('a', { hidden: true }), { selected: 'a' })).toBe(true)
  })

  it('keeps a hidden model when the active preset requires it', () => {
    expect(isVisibleInPicker(model('a', { hidden: true }), { required: ['a'] })).toBe(true)
  })

  it('shows everything when hidden models are explicitly included', () => {
    expect(isVisibleInPicker(model('a', { hidden: true }), { includeHidden: true })).toBe(true)
  })
})

describe('filterVisibleModels', () => {
  it('drops hidden models but keeps the selection', () => {
    const models = [
      model('keep'),
      model('gone', { hidden: true }),
      model('selected', { hidden: true }),
    ]

    const visible = filterVisibleModels(models, { selected: 'selected' }).map((m) => m.name)

    expect(visible).toEqual(['keep', 'selected'])
  })

  it('leaves a list with no preferences untouched', () => {
    const models = [model('a'), model('b')]
    expect(filterVisibleModels(models)).toEqual(models)
  })
})

describe('sortFavoritesFirst', () => {
  it('pins favorites to the top and preserves the order within each group', () => {
    const models = [
      model('first'),
      model('fav-a', { favorite: true }),
      model('second'),
      model('fav-b', { favorite: true }),
    ]

    // Catalog order is models.json priority order, so it must survive sorting.
    expect(sortFavoritesFirst(models).map((m) => m.name)).toEqual([
      'fav-a',
      'fav-b',
      'first',
      'second',
    ])
  })
})

describe('withPreferenceFlags', () => {
  const flagsFrom = (hidden: ReadonlySet<string>) => (model: { name: string }) => ({
    hidden: hidden.has(model.name),
    favorite: false,
  })

  it('attaches the looked-up flags without touching the rest of the model', () => {
    const models = [{ name: 'a', downloaded: true }, { name: 'b' }]

    const withFlags = withPreferenceFlags(models, flagsFrom(new Set(['b'])))

    expect(withFlags).toEqual([
      { name: 'a', downloaded: true, hidden: false, favorite: false },
      { name: 'b', hidden: true, favorite: false },
    ])
  })

  it('reads through the lookup on every call', () => {
    // The bug this guards against: flags baked into a catalog snapshot that is
    // only rebuilt on refresh, so hiding a model left every picker showing the
    // stale value. Resolving through the lookup each time is the whole point.
    const models = [{ name: 'a' }]
    const hidden = new Set<string>()
    const flagsFor = flagsFrom(hidden)

    expect(withPreferenceFlags(models, flagsFor)[0].hidden).toBe(false)
    hidden.add('a')
    expect(withPreferenceFlags(models, flagsFor)[0].hidden).toBe(true)
  })

  it('overrides any flags already on the incoming model', () => {
    const models = [{ name: 'a', hidden: true, favorite: true }]

    expect(withPreferenceFlags(models, flagsFrom(new Set()))).toEqual([
      { name: 'a', hidden: false, favorite: false },
    ])
  })

  it('feeds a picker filter that then hides the model', () => {
    const models = [{ name: 'a' }, { name: 'b' }]

    const visible = filterVisibleModels(withPreferenceFlags(models, flagsFrom(new Set(['b']))))

    expect(visible.map((m) => m.name)).toEqual(['a'])
  })
})

describe('filterVisibleNames', () => {
  const hidden = new Set(['org---repo\\hidden.safetensors'])
  const isHidden = (name: string) => hidden.has(name)

  it('drops hidden names from a plain string list', () => {
    const names = ['org---repo\\a.safetensors', 'org---repo\\hidden.safetensors']
    expect(filterVisibleNames(names, isHidden)).toEqual(['org---repo\\a.safetensors'])
  })

  it('keeps a hidden name that must survive', () => {
    const names = ['org---repo\\hidden.safetensors']
    expect(filterVisibleNames(names, isHidden, ['org---repo\\hidden.safetensors'])).toEqual(names)
  })
})
