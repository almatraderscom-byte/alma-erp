import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const verifier = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-ios-voice-preview-catalog.mjs')
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const canonicalMediaPath = join(
  repositoryRoot,
  'ios/App/App/VoicePreviews/live-bn-v1',
  'gemini-2-5-flash-native-audio-preview-12-2025--aoede--bn-BD--v1--aac-v1.m4a',
)
const catalogVersion = 'live-bn-v1'
const models = [
  {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    filenamePrefix: 'gemini-2-5-flash-native-audio-preview-12-2025',
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    filenamePrefix: 'gemini-3-1-flash-live-preview',
  },
]
const voices = [
  { id: 'Aoede', persona: 'মায়া' },
  { id: 'Achernar', persona: 'নীলা' },
  { id: 'Kore', persona: 'তারা' },
  { id: 'Charon', persona: 'আরিফ' },
  { id: 'Orus', persona: 'অর্ক' },
  { id: 'Sulafat', persona: 'সামি' },
]
const fixtureRoots = new Set()

test.after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function writeManifest(fixture) {
  write(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`)
}

function createFixture({ approved = false, realMedia = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alma-ios-voice-catalog-')))
  fixtureRoots.add(root)
  const manifestPath = join(root, 'config/voice-preview-catalog/live-bn-v1.json')
  const publicRoot = join(root, 'public/voice-previews/live-bn-v1')
  const bundleRoot = join(root, 'ios/App/App/VoicePreviews/live-bn-v1')
  const fakeBinRoot = join(root, 'test-bin')
  const afinfoLog = join(root, 'afinfo-invocations.log')
  const entries = []
  const canonicalMedia = realMedia ? readFileSync(canonicalMediaPath) : null

  for (const model of models) {
    for (const voice of voices) {
      const filename = `${model.filenamePrefix}--${voice.id.toLowerCase()}--bn-BD--v1--aac-v1.m4a`
      const bytes = canonicalMedia
        ?? Buffer.from(`deterministic-m4a-fixture\0${model.id}\0${voice.id}\n`, 'utf8')
      write(join(publicRoot, filename), bytes)
      write(join(bundleRoot, filename), bytes)
      entries.push({
        modelID: model.id,
        modelLifecycle: 'preview',
        voiceID: voice.id,
        persona: voice.persona,
        filename,
        sha256: hash(bytes),
        byteSize: bytes.length,
        durationSeconds: realMedia ? 11.64 : 1.25,
        approved,
        generatedAt: '2026-08-09T11:14:52.559Z',
        generationTranscript: null,
      })
    }
  }

  const manifest = {
    schemaVersion: 1,
    catalogVersion,
    status: 'generated_pending_owner_approval',
    locale: 'bn-BD',
    scriptVersion: 'v1',
    codecVersion: 'aac-v1',
    cdnPath: '/voice-previews/live-bn-v1/',
    cache: {
      immutable: true,
      memory: true,
      diskLimitBytes: 33_554_432,
      revalidateAfterSeconds: 604_800,
      checksum: 'sha256',
    },
    scriptLines: [
      'আসসালামু আলাইকুম Boss, আমি ALMA।',
      'আপনার কথা মন দিয়ে শুনছি।',
      'বিষয়টি সহজ ও পরিষ্কারভাবে বুঝিয়ে বলব।',
      'আপনি মাঝখানে কথা বললেই আমি থেমে শুনব।',
    ],
    entries,
    generatedAt: '2026-08-09T11:43:32.017Z',
  }
  const fakeAfinfo = join(fakeBinRoot, 'afinfo')
  write(fakeAfinfo, `#!/bin/sh
if [ -n "\${ALMA_FAKE_AFINFO_LOG:-}" ]; then
  printf '%s\\n' "$1" >> "$ALMA_FAKE_AFINFO_LOG"
fi
mode="\${ALMA_FAKE_AFINFO_MODE:-valid}"
channels=1
rate=24000
codec=aac
layout=Mono
duration=1.250000
case "$mode" in
  wrong-codec) codec=alac ;;
  wrong-rate) rate=48000 ;;
  wrong-channel-count) channels=2 ;;
  wrong-channel-layout) layout=Stereo ;;
  wrong-duration) duration=1.270001 ;;
  failure) echo 'fixture decode failure' >&2; exit 7 ;;
esac
printf 'Data format:     %s ch,  %s Hz, %s  (0x00000000)\\n' "$channels" "$rate" "$codec"
printf 'File type ID:   %s\\n' "\${ALMA_FAKE_AFINFO_FILE_TYPE:-m4af}"
printf 'Num Tracks:     %s\\n' "\${ALMA_FAKE_AFINFO_TRACKS:-1}"
printf 'estimated duration: %s sec\\n' "$duration"
printf 'Channel layout: %s\\n' "$layout"
`)
  chmodSync(fakeAfinfo, 0o755)
  const fixture = {
    root,
    manifestPath,
    publicRoot,
    bundleRoot,
    fakeBinRoot,
    afinfoLog,
    manifest,
  }
  writeManifest(fixture)
  return fixture
}

function invoke(
  fixture,
  extraArguments = [],
  { afinfoMode = 'valid', fileType = 'm4af', tracks = '1' } = {},
) {
  return spawnSync(process.execPath, [
    verifier,
    '--repository-root',
    fixture.root,
    ...extraArguments,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ALMA_FAKE_AFINFO_LOG: fixture.afinfoLog,
      ALMA_FAKE_AFINFO_FILE_TYPE: fileType,
      ALMA_FAKE_AFINFO_MODE: afinfoMode,
      ALMA_FAKE_AFINFO_TRACKS: tracks,
      ALMA_VOICE_CATALOG_TEST_AFINFO: join(fixture.fakeBinRoot, 'afinfo'),
      PATH: `${fixture.fakeBinRoot}${delimiter}${process.env.PATH ?? ''}`,
    },
  })
}

function runFixtureGit(fixture, arguments_) {
  const result = spawnSync('/usr/bin/git', ['-C', fixture.root, ...arguments_], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'catalog-test@example.invalid',
      GIT_AUTHOR_NAME: 'Catalog Test',
      GIT_COMMITTER_EMAIL: 'catalog-test@example.invalid',
      GIT_COMMITTER_NAME: 'Catalog Test',
    },
  })
  assert.equal(
    result.status,
    0,
    `fixture git failed: git ${arguments_.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
  return result
}

function commitCatalogFixture(fixture) {
  runFixtureGit(fixture, ['init', '--quiet'])
  runFixtureGit(fixture, ['add', 'config', 'public', 'ios'])
  runFixtureGit(fixture, ['commit', '--quiet', '-m', 'catalog fixture'])
}

function createProductCopy(fixture) {
  const productRoot = join(fixture.root, 'Build', 'App.app')
  const productCatalogRoot = join(productRoot, 'VoicePreviews', catalogVersion)
  for (const entry of fixture.manifest.entries) {
    write(
      join(productCatalogRoot, entry.filename),
      readFileSync(join(fixture.bundleRoot, entry.filename)),
    )
  }
  return { productCatalogRoot, productRoot }
}

function createCommittedReleaseFixture() {
  const fixture = createFixture({ approved: true, realMedia: true })
  fixture.manifest.status = 'owner_approved_release_ready'
  writeManifest(fixture)
  commitCatalogFixture(fixture)
  return fixture
}

function assertPass(result, expectedFragment) {
  assert.equal(
    result.status,
    0,
    `expected PASS\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
  assert.match(result.stdout, /Voice preview catalog PASS: 12\/12 pairs, 12\/12 generated\+verified/)
  if (expectedFragment) assert.match(result.stdout, expectedFragment)
  assert.equal(result.stderr, '')
}

function assertFailure(result, expectedFragment) {
  assert.equal(
    result.status,
    1,
    `expected FAIL\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
  assert.match(result.stderr, /Voice preview catalog FAIL \(\d+\)/)
  if (expectedFragment) assert.match(result.stderr, expectedFragment)
  assert.equal(result.stdout, '')
}

test('technical verification passes all exact copies with 0/12 owner approvals', () => {
  const fixture = createFixture()
  assertPass(invoke(fixture), /0\/12 owner-approved, release=false/)
  const probedPaths = readFileSync(fixture.afinfoLog, 'utf8').trim().split('\n')
  assert.equal(probedPaths.length, 12)
  assert.equal(new Set(probedPaths).size, 12)
  for (const path of probedPaths) assert.equal(dirname(path), fixture.bundleRoot)
})

test('release verification fails closed until every entry has exact boolean approval', () => {
  const fixture = createFixture()
  assertFailure(
    invoke(fixture, ['--release']),
    /release requires status=owner_approved_release_ready and 12\/12 exact boolean approvals/,
  )

  const approvedFixture = createCommittedReleaseFixture()
  assertPass(
    invoke(approvedFixture, ['--release'], { afinfoMode: 'failure' }),
    /12\/12 owner-approved, release=true/,
  )
  const product = createProductCopy(approvedFixture)
  assertPass(
    invoke(
      approvedFixture,
      ['--release', '--product-root', product.productRoot],
      { afinfoMode: 'failure' },
    ),
    /12\/12 owner-approved, release=true/,
  )
  assert.throws(() => readFileSync(approvedFixture.afinfoLog), { code: 'ENOENT' })
})

test('release requires every catalog path to be a reproducible regular HEAD blob', async (t) => {
  await t.test('untracked repository', () => {
    const fixture = createFixture({ approved: true, realMedia: true })
    fixture.manifest.status = 'owner_approved_release_ready'
    writeManifest(fixture)
    assertFailure(invoke(fixture, ['--release']), /release Git root unavailable/)
  })

  await t.test('committed rm-cached and ignored asset', () => {
    const fixture = createCommittedReleaseFixture()
    const relativePath = `public/voice-previews/${catalogVersion}/${fixture.manifest.entries[0].filename}`
    runFixtureGit(fixture, ['rm', '--quiet', '--cached', '--', relativePath])
    write(join(fixture.root, '.gitignore'), `${relativePath}\n`)
    runFixtureGit(fixture, ['add', '.gitignore'])
    runFixtureGit(fixture, ['commit', '--quiet', '-m', 'hide catalog asset'])
    const result = invoke(fixture, ['--release'])
    assertFailure(result, /release HEAD must contain exactly the 24 canonical catalog asset paths/)
    assert.match(result.stderr, /release path is not a regular tracked HEAD blob:/)
  })

  for (const [name, flag] of [
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ]) {
    await t.test(name, () => {
      const fixture = createCommittedReleaseFixture()
      const relativePath = 'config/voice-preview-catalog/live-bn-v1.json'
      runFixtureGit(fixture, ['update-index', flag, '--', relativePath])
      fixture.manifest.generatedAt = '2026-08-10T11:43:32.017Z'
      writeManifest(fixture)
      assertFailure(
        invoke(fixture, ['--release']),
        /release worktree bytes differ from HEAD: config\/voice-preview-catalog\/live-bn-v1\.json/,
      )
    })
  }
})

test('rejects all-approved entries that remain in pending status', () => {
  const fixture = createFixture({ approved: true })
  assertFailure(
    invoke(fixture),
    /generated_pending_owner_approval requires at least one entry with approved=false/,
  )
})

test('rejects release-ready status with partial approval', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].approved = true
  fixture.manifest.status = 'owner_approved_release_ready'
  writeManifest(fixture)
  assertFailure(
    invoke(fixture),
    /owner_approved_release_ready requires exactly 12\/12 entries with approved=true; got 1\/12/,
  )
})

test('rejects a missing public asset', () => {
  const fixture = createFixture()
  unlinkSync(join(fixture.publicRoot, fixture.manifest.entries[0].filename))
  assertFailure(invoke(fixture), /public asset missing:/)
})

test('rejects a missing bundled asset', () => {
  const fixture = createFixture()
  unlinkSync(join(fixture.bundleRoot, fixture.manifest.entries[0].filename))
  assertFailure(invoke(fixture), /bundle asset missing:/)
})

test('rejects extra files in either exact asset set', async (t) => {
  for (const [label, getRoot] of [
    ['public', (fixture) => fixture.publicRoot],
    ['bundle', (fixture) => fixture.bundleRoot],
  ]) {
    await t.test(label, () => {
      const fixture = createFixture()
      write(join(getRoot(fixture), 'not-in-catalog.m4a'), 'extra')
      assertFailure(invoke(fixture), new RegExp(`${label} unexpected asset:`))
    })
  }
})

test('rejects nested asset content rather than overlooking it', () => {
  const fixture = createFixture()
  write(join(fixture.publicRoot, 'nested', 'hidden.m4a'), 'hidden')
  const result = invoke(fixture)
  assertFailure(result, /public unexpected asset: "nested"/)
  assert.match(result.stderr, /public asset must be a regular file: "nested"/)
})

test('rejects duplicate and missing model/voice pairs', () => {
  const fixture = createFixture()
  fixture.manifest.entries[11] = structuredClone(fixture.manifest.entries[0])
  writeManifest(fixture)
  const result = invoke(fixture)
  assertFailure(result, /duplicates model\/voice pair:/)
  assert.match(result.stderr, /missing model\/voice pair:/)
})

test('rejects unexpected model or voice IDs', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].voiceID = 'UnknownVoice'
  writeManifest(fixture)
  const result = invoke(fixture)
  assertFailure(result, /unexpected model\/voice pair:/)
  assert.match(result.stderr, /missing model\/voice pair:/)
})

test('rejects traversal filenames without reading outside either asset root', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].filename = '../escape.m4a'
  write(join(fixture.root, 'public/voice-previews/escape.m4a'), 'must-not-be-used')
  writeManifest(fixture)
  const result = invoke(fixture)
  assertFailure(result, /filename must be a safe leaf filename/)
  assert.match(result.stderr, /filename mismatch/)
})

test('rejects a symlink asset even when its target bytes are correct', () => {
  const fixture = createFixture()
  const entry = fixture.manifest.entries[0]
  const asset = join(fixture.publicRoot, entry.filename)
  const target = join(fixture.root, 'symlink-target.m4a')
  write(target, readFileSync(asset))
  unlinkSync(asset)
  symlinkSync(target, asset)
  assertFailure(invoke(fixture), /public asset must not be a symlink:/)
})

test('rejects a symlink in an asset-root path component', () => {
  const fixture = createFixture()
  const originalRoot = `${fixture.publicRoot}-physical`
  renameSync(fixture.publicRoot, originalRoot)
  symlinkSync(originalRoot, fixture.publicRoot)
  assertFailure(invoke(fixture), /public path must not contain a symlink:/)
})

test('rejects a non-regular asset', () => {
  const fixture = createFixture()
  const asset = join(fixture.bundleRoot, fixture.manifest.entries[0].filename)
  unlinkSync(asset)
  mkdirSync(asset)
  assertFailure(invoke(fixture), /bundle asset must be a regular file:/)
})

test('rejects checksums that do not match both copies', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].sha256 = '0'.repeat(64)
  writeManifest(fixture)
  const result = invoke(fixture)
  assertFailure(result, /public checksum mismatch:/)
  assert.match(result.stderr, /bundle checksum mismatch:/)
})

test('rejects malformed checksum syntax before copy metadata can be trusted', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].sha256 = fixture.manifest.entries[0].sha256.toUpperCase()
  writeManifest(fixture)
  assertFailure(invoke(fixture), /sha256 must be 64 lowercase hexadecimal characters/)
})

test('rejects a declared byte size that differs from both exact copies', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].byteSize += 1
  writeManifest(fixture)
  const result = invoke(fixture)
  assertFailure(result, /public byte-size mismatch:/)
  assert.match(result.stderr, /bundle byte-size mismatch:/)
})

test('rejects public/bundle copy inequality', () => {
  const fixture = createFixture()
  const entry = fixture.manifest.entries[0]
  const path = join(fixture.bundleRoot, entry.filename)
  const bytes = readFileSync(path)
  bytes[0] ^= 0xff
  write(path, bytes)
  const result = invoke(fixture)
  assertFailure(result, /bundle checksum mismatch:/)
  assert.match(result.stderr, /public\/bundle copy mismatch:/)
})

test('product mode proves the exact built App.app catalog copy', async (t) => {
  await t.test('exact product', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    assertPass(
      invoke(fixture, ['--product-root', product.productRoot]),
      /0\/12 owner-approved, release=false/,
    )
  })

  await t.test('missing product asset', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    unlinkSync(join(product.productCatalogRoot, fixture.manifest.entries[0].filename))
    assertFailure(
      invoke(fixture, ['--product-root', product.productRoot]),
      /product asset missing:/,
    )
  })

  await t.test('extra product asset', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    write(join(product.productCatalogRoot, 'extra.m4a'), 'extra')
    assertFailure(
      invoke(fixture, ['--product-root', product.productRoot]),
      /product unexpected asset:/,
    )
  })

  await t.test('corrupt product asset', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    const productAsset = join(product.productCatalogRoot, fixture.manifest.entries[0].filename)
    write(productAsset, Buffer.from('corrupt product copy'))
    const result = invoke(fixture, ['--product-root', product.productRoot])
    assertFailure(result, /product byte-size mismatch:/)
    assert.match(result.stderr, /product checksum mismatch:/)
    assert.match(result.stderr, /bundle\/product copy mismatch:/)
  })

  await t.test('symlinked product asset', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    const productAsset = join(product.productCatalogRoot, fixture.manifest.entries[0].filename)
    const target = join(fixture.root, 'product-target.m4a')
    write(target, readFileSync(productAsset))
    unlinkSync(productAsset)
    symlinkSync(target, productAsset)
    assertFailure(
      invoke(fixture, ['--product-root', product.productRoot]),
      /product asset must not be a symlink:/,
    )
  })

  await t.test('product-root ancestor symlink', () => {
    const fixture = createFixture()
    const product = createProductCopy(fixture)
    const physicalBuild = dirname(product.productRoot)
    const buildAlias = join(fixture.root, 'BuildAlias')
    symlinkSync(physicalBuild, buildAlias)
    assertFailure(
      invoke(fixture, ['--product-root', join(buildAlias, 'App.app')]),
      /product root must not contain an ancestor symlink/,
    )
  })
})

test('fails closed on malformed or undecodable bundled media metadata', async (t) => {
  for (const [name, options, expected] of [
    ['file type', { fileType: 'WAVE' }, /bundle afinfo file-type mismatch:/],
    ['track count', { tracks: '2' }, /bundle afinfo track-count mismatch:/],
    ['codec', { afinfoMode: 'wrong-codec' }, /bundle afinfo codec mismatch:/],
    ['sample rate', { afinfoMode: 'wrong-rate' }, /bundle afinfo sample-rate mismatch:/],
    ['channel count', { afinfoMode: 'wrong-channel-count' }, /bundle afinfo channel-count mismatch:/],
    ['channel layout', { afinfoMode: 'wrong-channel-layout' }, /bundle afinfo channel-layout mismatch:/],
    ['duration', { afinfoMode: 'wrong-duration' }, /bundle afinfo duration mismatch:/],
    ['probe failure', { afinfoMode: 'failure' }, /bundle afinfo probe failed:/],
  ]) {
    await t.test(name, () => {
      const fixture = createFixture()
      assertFailure(invoke(fixture, [], options), expected)
    })
  }
})

test('rejects filenames that are safe but not the exact pair filename', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].filename = 'different--bn-BD--v1--aac-v1.m4a'
  writeManifest(fixture)
  assertFailure(invoke(fixture), /filename mismatch for/)
})

test('enforces all six current Swift/TypeScript persona names for both models', async (t) => {
  for (const voice of voices) {
    await t.test(voice.id, () => {
      const fixture = createFixture()
      const entry = fixture.manifest.entries.find((candidate) => candidate.voiceID === voice.id)
      entry.persona = `${voice.persona}-stale`
      writeManifest(fixture)
      assertFailure(invoke(fixture), new RegExp(`persona for ${voice.id} must be ${voice.persona}`))
    })
  }
})

test('non-null generation transcripts normalize to the exact immutable script', () => {
  const fixture = createFixture()
  fixture.manifest.entries[0].generationTranscript = fixture.manifest.scriptLines.join('\n')
  writeManifest(fixture)
  assertPass(invoke(fixture), /0\/12 owner-approved, release=false/)

  fixture.manifest.entries[0].generationTranscript += ' changed'
  writeManifest(fixture)
  assertFailure(invoke(fixture), /generationTranscript must normalize to the exact immutable preview script/)
})

test('catalog personas remain semantically identical to the current Swift and TypeScript contracts', () => {
  const swift = readFileSync(join(repositoryRoot, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
  const typeScriptTest = readFileSync(
    join(repositoryRoot, 'src/agent/lib/__tests__/native-voice-upload-contract.test.ts'),
    'utf8',
  )
  for (const voice of voices) {
    const exactSourceFragment = `.init(id: "${voice.id}", name: "${voice.persona}"`
    assert.match(swift, new RegExp(exactSourceFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(typeScriptTest, new RegExp(exactSourceFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('rejects non-boolean approval values in technical and release modes', async (t) => {
  for (const malformed of ['false', 0, null]) {
    await t.test(JSON.stringify(malformed), () => {
      const fixture = createFixture()
      fixture.manifest.entries[0].approved = malformed
      writeManifest(fixture)
      assertFailure(invoke(fixture), /approved must be a boolean/)
      const releaseResult = invoke(fixture, ['--release'])
      assertFailure(releaseResult, /approved must be a boolean/)
      assert.match(releaseResult.stderr, /release requires status=owner_approved_release_ready and 12\/12 exact boolean approvals/)
    })
  }
})

test('rejects unknown or incorrectly typed catalog status', async (t) => {
  for (const malformed of ['approved', 'pending_owner_generation', true, null]) {
    await t.test(JSON.stringify(malformed), () => {
      const fixture = createFixture()
      fixture.manifest.status = malformed
      writeManifest(fixture)
      assertFailure(invoke(fixture), /status must be one of: generated_pending_owner_approval, owner_approved_release_ready/)
    })
  }
})

test('enforces closed root, cache, and entry key sets', async (t) => {
  for (const [name, mutate, expected] of [
    ['root extra', (manifest) => { manifest.release = false }, /manifest keys mismatch:/],
    ['cache extra', (manifest) => { manifest.cache.policy = 'mutable' }, /cache keys mismatch:/],
    ['entry extra', (manifest) => { manifest.entries[0].url = 'https:\/\/example.invalid' }, /entries\[0\] keys mismatch:/],
  ]) {
    await t.test(name, () => {
      const fixture = createFixture()
      mutate(fixture.manifest)
      writeManifest(fixture)
      assertFailure(invoke(fixture), expected)
    })
  }
})

test('rejects malformed schema types and fixed cache policy values', async (t) => {
  for (const [name, mutate, expected] of [
    ['schema string', (manifest) => { manifest.schemaVersion = '1' }, /schemaVersion must be the number 1/],
    ['entries object', (manifest) => { manifest.entries = {} }, /entries must be an array/],
    ['script string', (manifest) => { manifest.scriptLines = 'not-an-array' }, /scriptLines must exactly match the four immutable Bengali preview lines/],
    ['script wording', (manifest) => { manifest.scriptLines[3] = 'different wording' }, /scriptLines must exactly match the four immutable Bengali preview lines/],
    ['cache mutable', (manifest) => { manifest.cache.immutable = false }, /cache\.immutable must be true/],
    ['cache checksum', (manifest) => { manifest.cache.checksum = 'sha1' }, /cache\.checksum must be sha256/],
  ]) {
    await t.test(name, () => {
      const fixture = createFixture()
      mutate(fixture.manifest)
      writeManifest(fixture)
      assertFailure(invoke(fixture), expected)
    })
  }
})

test('rejects malformed JSON with a controlled catalog failure', () => {
  const fixture = createFixture()
  write(fixture.manifestPath, '{not-json')
  assertFailure(invoke(fixture), /manifest is not valid JSON:/)
})

test('rejects duplicate manifest keys hidden by JSON.parse last-value semantics', async (t) => {
  for (const [name, mutateSource] of [
    [
      'duplicate root status',
      (source) => source.replace(
        '  "status": "generated_pending_owner_approval",',
        '  "status": "owner_approved_release_ready",\n  "status": "generated_pending_owner_approval",',
      ),
    ],
    [
      'duplicate entry approval',
      (source) => source.replace(
        '      "approved": false,',
        '      "approved": false,\n      "approved": true,',
      ),
    ],
  ]) {
    await t.test(name, () => {
      const fixture = createFixture()
      const source = readFileSync(fixture.manifestPath, 'utf8')
      const mutated = mutateSource(source)
      assert.notEqual(mutated, source, 'duplicate-key fixture mutation must apply')
      write(fixture.manifestPath, mutated)
      assertFailure(
        invoke(fixture),
        /manifest must use the exact canonical JSON encoding without duplicate keys/,
      )
    })
  }
})

test('rejects manifest symlinks', () => {
  const fixture = createFixture()
  const target = join(fixture.root, 'manifest-target.json')
  renameSync(fixture.manifestPath, target)
  symlinkSync(target, fixture.manifestPath)
  assertFailure(invoke(fixture), /manifest path must not contain a symlink:/)
})

test('rejects unknown command-line arguments', () => {
  const fixture = createFixture()
  assertFailure(invoke(fixture, ['--relase']), /unknown argument: --relase/)
})

test('TestFlight preflight invokes the exact release verifier and never invokes the generator', () => {
  const preflight = readFileSync(join(repositoryRoot, 'scripts/ios-build-preflight.sh'), 'utf8')
  assert.match(
    preflight,
    /^if ! node "\$REPOSITORY_ROOT\/scripts\/verify-ios-voice-preview-catalog\.mjs" --release; then$/m,
  )
  assert.doesNotMatch(preflight, /generate-ios-voice-preview-catalog\.mjs/)
})

test('Xcode verifies the copied App.app catalog and requires release approval for archive builds', () => {
  const project = readFileSync(join(repositoryRoot, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
  const phase = project.match(
    /C8A0D1000000000000000012 \/\* Generate Build Provenance \*\/ = \{[\s\S]*?\n\t\t\};/,
  )?.[0]
  assert.ok(phase, 'Generate Build Provenance phase is missing')
  assert.match(phase, /--product-root \\\"\$\{PRODUCT_ROOT_PHYSICAL\}\\\"/)
  assert.match(phase, /CATALOG_ARGS\+=\(--release\)/)
  assert.match(
    phase,
    /node \\\"\$\{SRCROOT\}\/\.\.\/\.\.\/scripts\/verify-ios-voice-preview-catalog\.mjs\\\" \\\"\$\{CATALOG_ARGS\[@\]\}\\\"/,
  )
  assert.match(
    phase,
    /\$\(TARGET_BUILD_DIR\)\/\$\(UNLOCALIZED_RESOURCES_FOLDER_PATH\)\/VoicePreviews\/live-bn-v1/,
  )
})
