import { describe, expect, it } from 'vitest'
import {
  filterVisibleModels,
  filterVisibleNames,
  isVisibleInPicker,
  sortFavoritesFirst,
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
