import { describe, expect, it } from 'vitest'
import { usersModifyIcaclsArgs } from '../sharedAcl.ts'

describe('usersModifyIcaclsArgs', () => {
  it('grants inheritable modify and a direct modify on every existing file', () => {
    expect(usersModifyIcaclsArgs('C:\\shared\\service\\.venv')).toEqual([
      'C:\\shared\\service\\.venv',
      '/grant',
      '*S-1-5-32-545:(OI)(CI)M',
      '/grant',
      '*S-1-5-32-545:M',
      '/T',
      '/C',
    ])
  })

  it('can stamp only the directory when the tree must not be walked', () => {
    expect(usersModifyIcaclsArgs('C:\\shared', false)).toEqual([
      'C:\\shared',
      '/grant',
      '*S-1-5-32-545:(OI)(CI)M',
      '/grant',
      '*S-1-5-32-545:M',
      '/C',
    ])
  })
})
