import { describe, expect, it } from 'vitest'
import { parseRepoSource, refCandidates, repoLabel, tarballUrl } from './github'

describe('parseRepoSource', () => {
  it.each([
    ['vercel-labs/skills', { owner: 'vercel-labs', repo: 'skills', ref: null, subPath: null }],
    ['owner/repo.git', { owner: 'owner', repo: 'repo', ref: null, subPath: null }],
    ['https://github.com/anthropics/skills', { owner: 'anthropics', repo: 'skills', ref: null, subPath: null }],
    ['github.com/anthropics/skills', { owner: 'anthropics', repo: 'skills', ref: null, subPath: null }],
    ['https://www.github.com/o/r/', { owner: 'o', repo: 'r', ref: null, subPath: null }],
    ['https://github.com/o/r/tree/main', { owner: 'o', repo: 'r', ref: 'main', subPath: null }],
    ['https://github.com/o/r/tree/v2/skills/foo', { owner: 'o', repo: 'r', ref: 'v2', subPath: 'skills/foo' }],
  ])('%s 可解析', (input, expected) => {
    expect(parseRepoSource(input)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    'single-segment',
    'https://gitlab.com/o/r',
    'https://github.com/onlyowner',
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/tree',
    'not a url at all',
  ])('%s 拒绝', (input) => {
    expect(parseRepoSource(input)).toBeNull()
  })
})

describe('refCandidates / tarballUrl / repoLabel', () => {
  it('显式 ref 只试它；缺省 HEAD → main → master 兜底', () => {
    expect(refCandidates({ owner: 'o', repo: 'r', ref: 'dev', subPath: null })).toEqual(['dev'])
    expect(refCandidates({ owner: 'o', repo: 'r', ref: null, subPath: null })).toEqual(['HEAD', 'main', 'master'])
  })

  it('codeload tarball 地址与展示标签', () => {
    const source = { owner: 'vercel-labs', repo: 'skills', ref: 'main', subPath: 'skills/find' }
    expect(tarballUrl(source, 'main')).toBe('https://codeload.github.com/vercel-labs/skills/tar.gz/main')
    expect(repoLabel(source)).toBe('vercel-labs/skills@main/skills/find')
    expect(repoLabel({ owner: 'o', repo: 'r', ref: null, subPath: null })).toBe('o/r')
  })
})
