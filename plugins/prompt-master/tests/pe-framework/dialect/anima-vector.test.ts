import { describe, expect, it } from 'vitest'
import { E5_PASSAGE_PREFIX, E5_QUERY_PREFIX } from '../../../src/pe-framework/dialect/anima-vector.js'

describe('e5 prefix constants', () => {
  it('query/passage prefixes follow e5 convention', () => {
    expect(E5_QUERY_PREFIX).toBe('query: ')
    expect(E5_PASSAGE_PREFIX).toBe('passage: ')
  })
})
