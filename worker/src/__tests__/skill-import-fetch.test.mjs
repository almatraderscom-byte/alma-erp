import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateRepoUrl,
  validateCommit,
  fetchPinnedSkillPackage,
  _fetchFromResolvedUrl,
} from '../skill-import/fetch.mjs'

test('validateRepoUrl accepts github https, rejects other hosts/protocols', () => {
  assert.equal(validateRepoUrl('https://github.com/user/repo'), 'https://github.com/user/repo.git')
  assert.equal(validateRepoUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo.git')
  assert.throws(() => validateRepoUrl('https://gitlab.com/user/repo'), /allowlist/)
  assert.throws(() => validateRepoUrl('http://github.com/user/repo'), /https/)
  assert.throws(() => validateRepoUrl('https://github.com/user'), /owner.*repo/i)
})

test('validateCommit requires a full 40-hex sha (no branches/tags)', () => {
  assert.equal(validateCommit('a'.repeat(40)), 'a'.repeat(40))
  assert.throws(() => validateCommit('main'), /40-char/)
  assert.throws(() => validateCommit('abc123'), /40-char/)
})

test('fetchPinnedSkillPackage enforces host + commit validation before any clone', async () => {
  await assert.rejects(fetchPinnedSkillPackage({ repo: 'https://evil.com/a/b', commit: 'a'.repeat(40) }), /allowlist/)
  await assert.rejects(fetchPinnedSkillPackage({ repo: 'https://github.com/a/b', commit: 'main' }), /40-char/)
})

test('clones a pinned commit from a local fixture and reads the package (hermetic, no network)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alma-skill-fixture-'))
  const git = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim()
  try {
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' })
    // Allow a local file:// remote to serve an arbitrary reachable sha + blob filter.
    git(['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    git(['config', 'uploadpack.allowFilter', 'true'])
    git(['config', 'user.email', 'test@alma.local'])
    git(['config', 'user.name', 'alma test'])

    await writeFile(join(root, 'SKILL.md'), '---\nname: ext\nkeywords: hi\n---\n# Ext skill\nStep 1.')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ name: 'ext', version: '0.1.0' }))
    await mkdir(join(root, 'references'), { recursive: true })
    await writeFile(join(root, 'references', 'a.md'), 'ref A')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'scripts', 's.ts'), 'export const x = 1')
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', 'init'])
    const sha = git(['rev-parse', 'HEAD'])

    const pkg = await _fetchFromResolvedUrl(`file://${root}`, sha)
    assert.match(pkg.skillMd, /Ext skill/)
    assert.equal(pkg.manifest.name, 'ext')
    assert.deepEqual(pkg.references, ['ref A'])
    assert.deepEqual(pkg.scripts, ['export const x = 1'])
    assert.equal(pkg.sourceCommit, sha.toLowerCase())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sparse-checkout reads only the pinned subdir from a repo with many folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alma-skill-sub-'))
  const git = (args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }).toString().trim()
  try {
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe' })
    git(['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    git(['config', 'uploadpack.allowFilter', 'true'])
    git(['config', 'user.email', 'test@alma.local'])
    git(['config', 'user.name', 'alma test'])

    await mkdir(join(root, 'other'), { recursive: true })
    await writeFile(join(root, 'other', 'big.txt'), 'x'.repeat(1000))
    await mkdir(join(root, 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(root, 'skills', 'my-skill', 'SKILL.md'), '---\nname: sub\n---\n# Sub skill')
    await writeFile(join(root, 'skills', 'my-skill', 'manifest.json'), JSON.stringify({ name: 'sub', version: '1.0.0' }))
    git(['add', '-A'])
    git(['commit', '--quiet', '-m', 'init'])
    const sha = git(['rev-parse', 'HEAD'])

    const pkg = await _fetchFromResolvedUrl(`file://${root}`, sha, 'skills/my-skill')
    assert.equal(pkg.manifest.name, 'sub')
    assert.match(pkg.skillMd, /Sub skill/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
