#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CATALOG_VERSION = 'live-bn-v1'
const MANIFEST_RELATIVE_PATH = `config/voice-preview-catalog/${CATALOG_VERSION}.json`
const PUBLIC_RELATIVE_ROOT = `public/voice-previews/${CATALOG_VERSION}`
const BUNDLE_RELATIVE_ROOT = `ios/App/App/VoicePreviews/${CATALOG_VERSION}`
const PRODUCT_RELATIVE_ROOT = `VoicePreviews/${CATALOG_VERSION}`
const PENDING_STATUS = 'generated_pending_owner_approval'
const RELEASE_READY_STATUS = 'owner_approved_release_ready'
const MANIFEST_KEYS = [
  'cache',
  'catalogVersion',
  'cdnPath',
  'codecVersion',
  'entries',
  'generatedAt',
  'locale',
  'schemaVersion',
  'scriptLines',
  'scriptVersion',
  'status',
]
const CACHE_KEYS = [
  'checksum',
  'diskLimitBytes',
  'immutable',
  'memory',
  'revalidateAfterSeconds',
]
const ENTRY_KEYS = [
  'approved',
  'byteSize',
  'durationSeconds',
  'filename',
  'generatedAt',
  'generationTranscript',
  'modelID',
  'modelLifecycle',
  'persona',
  'sha256',
  'voiceID',
]
const MODELS = [
  {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    filenamePrefix: 'gemini-2-5-flash-native-audio-preview-12-2025',
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    filenamePrefix: 'gemini-3-1-flash-live-preview',
  },
]
const VOICES = [
  { id: 'Aoede', persona: 'মায়া' },
  { id: 'Achernar', persona: 'নীলা' },
  { id: 'Kore', persona: 'তারা' },
  { id: 'Charon', persona: 'আরিফ' },
  { id: 'Orus', persona: 'অর্ক' },
  { id: 'Sulafat', persona: 'সামি' },
]
const SCRIPT_LINES = [
  'আসসালামু আলাইকুম Boss, আমি ALMA।',
  'আপনার কথা মন দিয়ে শুনছি।',
  'বিষয়টি সহজ ও পরিষ্কারভাবে বুঝিয়ে বলব।',
  'আপনি মাঝখানে কথা বললেই আমি থেমে শুনব।',
]
const NORMALIZED_SCRIPT = SCRIPT_LINES.join(' ').replace(/\s+/gu, ' ').trim()
const EXPECTED_PAIRS = MODELS.flatMap((model) => VOICES.map((voice) => {
  const key = `${model.id}|${voice.id}`
  return {
    key,
    modelID: model.id,
    voiceID: voice.id,
    persona: voice.persona,
    filename: `${model.filenamePrefix}--${voice.id.toLowerCase()}--bn-BD--v1--aac-v1.m4a`,
  }
}))
const EXPECTED_BY_KEY = new Map(EXPECTED_PAIRS.map((pair) => [pair.key, pair]))
const EXPECTED_FILENAMES = new Set(EXPECTED_PAIRS.map((pair) => pair.filename))
const RELEASE_TRACKED_PATHS = [
  MANIFEST_RELATIVE_PATH,
  ...EXPECTED_PAIRS.map((pair) => `${PUBLIC_RELATIVE_ROOT}/${pair.filename}`),
  ...EXPECTED_PAIRS.map((pair) => `${BUNDLE_RELATIVE_ROOT}/${pair.filename}`),
]

function parseArguments(argv) {
  let repositoryRoot = process.cwd()
  let productRoot = null
  let release = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--release') {
      release = true
      continue
    }
    if (argument === '--repository-root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--repository-root requires a path')
      repositoryRoot = value
      index += 1
      continue
    }
    if (argument.startsWith('--repository-root=')) {
      const value = argument.slice('--repository-root='.length)
      if (!value) throw new Error('--repository-root requires a path')
      repositoryRoot = value
      continue
    }
    if (argument === '--product-root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--product-root requires a path')
      productRoot = value
      index += 1
      continue
    }
    if (argument.startsWith('--product-root=')) {
      const value = argument.slice('--product-root='.length)
      if (!value) throw new Error('--product-root requires a path')
      productRoot = value
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  return {
    productRoot,
    release,
    repositoryRoot: path.resolve(repositoryRoot),
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function printable(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function hasExactKeys(value, expectedKeys, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return false
  }
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    errors.push(`${label} keys mismatch: expected ${expected.join(',')}; got ${actual.join(',')}`)
    return false
  }
  return true
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const millisecondForm = value.includes('.') ? value : value.replace(/Z$/, '.000Z')
  return new Date(parsed).toISOString() === millisecondForm
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function runSystemGit(repositoryRoot, arguments_, encoding = 'utf8') {
  return spawnSync('/usr/bin/git', ['-C', repositoryRoot, ...arguments_], {
    encoding,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  })
}

function commandFailure(result) {
  return result.error?.code ?? result.error?.message
    ?? `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}`
}

async function validateReleaseHead(repositoryRoot, errors) {
  const topResult = runSystemGit(repositoryRoot, ['rev-parse', '--show-toplevel'])
  if (topResult.error || topResult.status !== 0) {
    errors.push(`release Git root unavailable (${commandFailure(topResult)})`)
    return
  }

  let physicalRoot
  let physicalTop
  try {
    physicalRoot = await realpath(repositoryRoot)
    physicalTop = await realpath(topResult.stdout.trim())
  } catch (error) {
    errors.push(`release Git root unreadable (${error.code ?? error.message})`)
    return
  }
  if (physicalRoot !== repositoryRoot || physicalTop !== physicalRoot) {
    errors.push('release repository root must be the exact physical Git worktree root')
    return
  }

  const headResult = runSystemGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (headResult.error || headResult.status !== 0
      || !/^[a-f0-9]{40,64}\n?$/.test(headResult.stdout)) {
    errors.push(`release HEAD is unavailable or invalid (${commandFailure(headResult)})`)
    return
  }

  const treeSetResult = runSystemGit(repositoryRoot, [
    'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--',
    PUBLIC_RELATIVE_ROOT,
    BUNDLE_RELATIVE_ROOT,
  ], null)
  if (treeSetResult.error || treeSetResult.status !== 0 || !Buffer.isBuffer(treeSetResult.stdout)) {
    errors.push(`release catalog tree cannot be enumerated (${commandFailure(treeSetResult)})`)
    return
  }
  const trackedAssetPaths = treeSetResult.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
  const expectedAssetPaths = RELEASE_TRACKED_PATHS.slice(1).sort()
  if (trackedAssetPaths.length !== expectedAssetPaths.length
      || trackedAssetPaths.some((value, index) => value !== expectedAssetPaths[index])) {
    errors.push('release HEAD must contain exactly the 24 canonical catalog asset paths')
  }

  for (const relativePath of RELEASE_TRACKED_PATHS) {
    const treeResult = runSystemGit(repositoryRoot, ['ls-tree', 'HEAD', '--', relativePath])
    const escaped = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const treePattern = new RegExp(`^100644 blob [a-f0-9]{40,64}\\t${escaped}\\n?$`)
    if (treeResult.error || treeResult.status !== 0 || !treePattern.test(treeResult.stdout)) {
      errors.push(`release path is not a regular tracked HEAD blob: ${relativePath}`)
      continue
    }

    const blobResult = runSystemGit(repositoryRoot, ['cat-file', 'blob', `HEAD:${relativePath}`], null)
    if (blobResult.error || blobResult.status !== 0 || !Buffer.isBuffer(blobResult.stdout)) {
      errors.push(`release HEAD blob unreadable: ${relativePath} (${commandFailure(blobResult)})`)
      continue
    }
    try {
      const worktreeBytes = await readFile(path.join(repositoryRoot, relativePath))
      if (!worktreeBytes.equals(blobResult.stdout)) {
        errors.push(`release worktree bytes differ from HEAD: ${relativePath}`)
      }
    } catch (error) {
      errors.push(`release worktree path unreadable: ${relativePath} (${error.code ?? error.message})`)
    }
  }
}

function isSafeLeafFilename(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === path.basename(value)
    && !path.isAbsolute(value)
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value !== '.'
    && value !== '..'
}

async function validateRepositoryRoot(repositoryRoot, errors) {
  try {
    const info = await lstat(repositoryRoot)
    if (info.isSymbolicLink()) {
      errors.push(`repository root must not be a symlink: ${repositoryRoot}`)
      return false
    }
    if (!info.isDirectory()) {
      errors.push(`repository root must be a directory: ${repositoryRoot}`)
      return false
    }
    return true
  } catch (error) {
    errors.push(`repository root missing/unreadable: ${repositoryRoot} (${error.code ?? error.message})`)
    return false
  }
}

async function validatePhysicalProductRoot(productRootArgument, errors) {
  if (typeof productRootArgument !== 'string' || !path.isAbsolute(productRootArgument)) {
    errors.push('product root must be an absolute physical App.app directory')
    return null
  }
  const logicalRoot = path.resolve(productRootArgument)
  let info
  let physicalRoot
  try {
    info = await lstat(logicalRoot)
    physicalRoot = await realpath(logicalRoot)
  } catch (error) {
    errors.push(`product root missing/unreadable: ${logicalRoot} (${error.code ?? error.message})`)
    return null
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    errors.push('product root must be a regular App.app directory, not a symlink')
    return null
  }
  if (physicalRoot !== logicalRoot) {
    errors.push('product root must not contain an ancestor symlink')
    return null
  }
  if (path.extname(physicalRoot) !== '.app') {
    errors.push('product root must be an App.app directory')
    return null
  }
  return physicalRoot
}

async function validatePathChain(repositoryRoot, relativePath, finalKind, label, errors) {
  const components = relativePath.split('/')
  let current = repositoryRoot
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      errors.push(`${label} missing/unreadable: ${relativePath} (${error.code ?? error.message})`)
      return false
    }
    if (info.isSymbolicLink()) {
      errors.push(`${label} path must not contain a symlink: ${path.relative(repositoryRoot, current)}`)
      return false
    }
    const isFinal = index === components.length - 1
    if (!isFinal && !info.isDirectory()) {
      errors.push(`${label} parent must be a directory: ${path.relative(repositoryRoot, current)}`)
      return false
    }
    if (isFinal && finalKind === 'file' && !info.isFile()) {
      errors.push(`${label} must be a regular file: ${relativePath}`)
      return false
    }
    if (isFinal && finalKind === 'directory' && !info.isDirectory()) {
      errors.push(`${label} must be a directory: ${relativePath}`)
      return false
    }
  }
  return true
}

async function inspectAssetDirectory(repositoryRoot, relativeRoot, label, errors) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot)
  if (!await validatePathChain(repositoryRoot, relativeRoot, 'directory', label, errors)) return new Map()

  let names
  try {
    names = await readdir(absoluteRoot)
  } catch (error) {
    errors.push(`${label} directory unreadable: ${relativeRoot} (${error.code ?? error.message})`)
    return new Map()
  }

  const actualSet = new Set(names)
  for (const filename of [...EXPECTED_FILENAMES].sort()) {
    if (!actualSet.has(filename)) errors.push(`${label} asset missing: ${filename}`)
  }
  for (const filename of [...actualSet].sort()) {
    if (!EXPECTED_FILENAMES.has(filename)) errors.push(`${label} unexpected asset: ${printable(filename)}`)
  }

  const verified = new Map()
  for (const filename of [...actualSet].sort()) {
    const filePath = path.join(absoluteRoot, filename)
    let info
    try {
      info = await lstat(filePath)
    } catch (error) {
      errors.push(`${label} asset unreadable: ${printable(filename)} (${error.code ?? error.message})`)
      continue
    }
    if (info.isSymbolicLink()) {
      errors.push(`${label} asset must not be a symlink: ${printable(filename)}`)
      continue
    }
    if (!info.isFile()) {
      errors.push(`${label} asset must be a regular file: ${printable(filename)}`)
      continue
    }
    if (!EXPECTED_FILENAMES.has(filename)) continue
    try {
      const bytes = await readFile(filePath)
      verified.set(filename, { bytes, byteSize: info.size, filePath, sha256: sha256(bytes) })
    } catch (error) {
      errors.push(`${label} asset unreadable: ${printable(filename)} (${error.code ?? error.message})`)
    }
  }
  return verified
}

function validateManifest(manifest, release, errors) {
  if (!hasExactKeys(manifest, MANIFEST_KEYS, 'manifest', errors)) return new Map()

  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be the number 1')
  if (manifest.catalogVersion !== CATALOG_VERSION) errors.push(`catalogVersion must be ${CATALOG_VERSION}`)
  if (manifest.status !== PENDING_STATUS && manifest.status !== RELEASE_READY_STATUS) {
    errors.push(`status must be one of: ${PENDING_STATUS}, ${RELEASE_READY_STATUS}`)
  }
  if (manifest.locale !== 'bn-BD') errors.push('locale must be bn-BD')
  if (manifest.scriptVersion !== 'v1') errors.push('scriptVersion must be v1')
  if (manifest.codecVersion !== 'aac-v1') errors.push('codecVersion must be aac-v1')
  if (manifest.cdnPath !== `/voice-previews/${CATALOG_VERSION}/`) {
    errors.push(`cdnPath must be /voice-previews/${CATALOG_VERSION}/`)
  }
  if (!isCanonicalTimestamp(manifest.generatedAt)) errors.push('manifest generatedAt must be a UTC ISO-8601 timestamp')

  if (hasExactKeys(manifest.cache, CACHE_KEYS, 'cache', errors)) {
    if (manifest.cache.immutable !== true) errors.push('cache.immutable must be true')
    if (manifest.cache.memory !== true) errors.push('cache.memory must be true')
    if (manifest.cache.diskLimitBytes !== 33_554_432) errors.push('cache.diskLimitBytes must be 33554432')
    if (manifest.cache.revalidateAfterSeconds !== 604_800) {
      errors.push('cache.revalidateAfterSeconds must be 604800')
    }
    if (manifest.cache.checksum !== 'sha256') errors.push('cache.checksum must be sha256')
  }

  if (!Array.isArray(manifest.scriptLines)
      || manifest.scriptLines.length !== SCRIPT_LINES.length
      || manifest.scriptLines.some((line, index) => line !== SCRIPT_LINES[index])) {
    errors.push('scriptLines must exactly match the four immutable Bengali preview lines')
  }

  if (!Array.isArray(manifest.entries)) {
    errors.push('entries must be an array')
    return new Map()
  }
  if (manifest.entries.length !== EXPECTED_PAIRS.length) {
    errors.push(`expected ${EXPECTED_PAIRS.length} entries, got ${manifest.entries.length}`)
  }

  const entriesByKey = new Map()
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index]
    const label = `entries[${index}]`
    if (!hasExactKeys(entry, ENTRY_KEYS, label, errors)) continue

    const key = `${entry.modelID}|${entry.voiceID}`
    const expected = EXPECTED_BY_KEY.get(key)
    if (!expected) {
      errors.push(`${label} has unexpected model/voice pair: ${printable(key)}`)
    } else if (entriesByKey.has(key)) {
      errors.push(`${label} duplicates model/voice pair: ${key}`)
    } else {
      entriesByKey.set(key, entry)
    }

    if (entry.modelLifecycle !== 'preview') errors.push(`${label}.modelLifecycle must be preview`)
    if (expected && entry.persona !== expected.persona) {
      errors.push(`${label}.persona for ${entry.voiceID} must be ${expected.persona}`)
    }
    if (!isSafeLeafFilename(entry.filename)) errors.push(`${label}.filename must be a safe leaf filename`)
    if (expected && entry.filename !== expected.filename) {
      errors.push(`${label}.filename mismatch for ${key}: expected ${expected.filename}`)
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`${label}.sha256 must be 64 lowercase hexadecimal characters`)
    }
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) {
      errors.push(`${label}.byteSize must be a positive safe integer`)
    }
    if (typeof entry.durationSeconds !== 'number'
        || !Number.isFinite(entry.durationSeconds)
        || entry.durationSeconds <= 0) {
      errors.push(`${label}.durationSeconds must be a positive finite number`)
    }
    if (typeof entry.approved !== 'boolean') errors.push(`${label}.approved must be a boolean`)
    if (!isCanonicalTimestamp(entry.generatedAt)) errors.push(`${label}.generatedAt must be a UTC ISO-8601 timestamp`)
    if (entry.generationTranscript !== null
        && (typeof entry.generationTranscript !== 'string' || entry.generationTranscript.trim().length === 0)) {
      errors.push(`${label}.generationTranscript must be null or a non-empty string`)
    } else if (typeof entry.generationTranscript === 'string'
        && entry.generationTranscript.replace(/\s+/gu, ' ').trim() !== NORMALIZED_SCRIPT) {
      errors.push(`${label}.generationTranscript must normalize to the exact immutable preview script`)
    }
  }

  for (const { key } of EXPECTED_PAIRS) {
    if (!entriesByKey.has(key)) errors.push(`missing model/voice pair: ${key}`)
  }

  const approvedCount = manifest.entries.filter((entry) => entry?.approved === true).length
  if (manifest.status === PENDING_STATUS && approvedCount === EXPECTED_PAIRS.length) {
    errors.push(`${PENDING_STATUS} requires at least one entry with approved=false`)
  }
  if (manifest.status === RELEASE_READY_STATUS && approvedCount !== EXPECTED_PAIRS.length) {
    errors.push(`${RELEASE_READY_STATUS} requires exactly 12/12 entries with approved=true; got ${approvedCount}/12`)
  }
  if (release && (manifest.status !== RELEASE_READY_STATUS || approvedCount !== EXPECTED_PAIRS.length)) {
    errors.push(
      `release requires status=${RELEASE_READY_STATUS} and 12/12 exact boolean approvals; `
        + `got status=${printable(manifest.status)}, approvals=${approvedCount}/12`,
    )
  }
  return entriesByKey
}

function afinfoExecutable(release) {
  const testExecutable = process.env.ALMA_VOICE_CATALOG_TEST_AFINFO
  if (!release && process.env.NODE_ENV === 'test'
      && typeof testExecutable === 'string' && path.isAbsolute(testExecutable)) {
    return testExecutable
  }
  return '/usr/bin/afinfo'
}

function probeBundledMedia(asset, entry, key, release, errors) {
  const result = spawnSync(afinfoExecutable(release), [asset.filePath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  })
  if (result.error || result.status !== 0) {
    const reason = result.error?.code ?? result.error?.message
      ?? `exit=${result.status ?? 'none'} signal=${result.signal ?? 'none'}`
    errors.push(`bundle afinfo probe failed: ${key} (${reason})`)
    return
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!/^File type ID:[ \t]+m4af[ \t]*\r?$/m.test(output)) {
    errors.push(`bundle afinfo file-type mismatch: ${key} (expected m4af)`)
  }
  if (!/^Num Tracks:[ \t]+1[ \t]*\r?$/m.test(output)) {
    errors.push(`bundle afinfo track-count mismatch: ${key} (expected 1)`)
  }
  const format = output.match(
    /^Data format:[ \t]+(\d+)[ \t]+ch,[ \t]+(\d+)[ \t]+Hz,[ \t]+([A-Za-z0-9._-]+)\b.*\r?$/m,
  )
  if (!format) {
    errors.push(`bundle afinfo data format missing/unparseable: ${key}`)
  } else {
    if (Number(format[1]) !== 1) errors.push(`bundle afinfo channel-count mismatch: ${key} (got ${format[1]} ch)`)
    if (Number(format[2]) !== 24_000) errors.push(`bundle afinfo sample-rate mismatch: ${key} (got ${format[2]} Hz)`)
    if (format[3] !== 'aac') errors.push(`bundle afinfo codec mismatch: ${key} (got ${printable(format[3])})`)
  }

  if (!/^Channel layout:[ \t]*Mono[ \t]*\r?$/m.test(output)) {
    errors.push(`bundle afinfo channel-layout mismatch: ${key} (expected Mono)`)
  }

  const durationMatch = output.match(
    /^estimated duration:[ \t]+([0-9]+(?:\.[0-9]+)?)[ \t]+sec[ \t]*\r?$/m,
  )
  const decodedDuration = durationMatch ? Number(durationMatch[1]) : Number.NaN
  if (!Number.isFinite(decodedDuration)) {
    errors.push(`bundle afinfo duration missing/unparseable: ${key}`)
  } else if (Math.abs(decodedDuration - entry.durationSeconds) > 0.01 + Number.EPSILON) {
    errors.push(
      `bundle afinfo duration mismatch: ${key} `
        + `(manifest=${entry.durationSeconds}, decoded=${decodedDuration}, tolerance=0.01s)`,
    )
  }
}

async function main() {
  const errors = []
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    errors.push(error.message)
  }

  let manifest
  let entriesByKey = new Map()
  let publicAssets = new Map()
  let bundledAssets = new Map()
  let productAssets = new Map()

  if (options && await validateRepositoryRoot(options.repositoryRoot, errors)) {
    if (options.release) await validateReleaseHead(options.repositoryRoot, errors)
    const manifestPath = path.join(options.repositoryRoot, MANIFEST_RELATIVE_PATH)
    if (await validatePathChain(options.repositoryRoot, MANIFEST_RELATIVE_PATH, 'file', 'manifest', errors)) {
      try {
        const manifestSource = await readFile(manifestPath, 'utf8')
        manifest = JSON.parse(manifestSource)
        const canonicalSource = `${JSON.stringify(manifest, null, 2)}\n`
        if (manifestSource !== canonicalSource) {
          errors.push('manifest must use the exact canonical JSON encoding without duplicate keys')
        }
      } catch (error) {
        errors.push(`manifest is not valid JSON: ${error.message}`)
      }
    }

    if (manifest !== undefined) entriesByKey = validateManifest(manifest, options.release, errors)
    const assets = await Promise.all([
      inspectAssetDirectory(options.repositoryRoot, PUBLIC_RELATIVE_ROOT, 'public', errors),
      inspectAssetDirectory(options.repositoryRoot, BUNDLE_RELATIVE_ROOT, 'bundle', errors),
    ])
    publicAssets = assets[0]
    bundledAssets = assets[1]
    if (options.productRoot !== null) {
      const physicalProductRoot = await validatePhysicalProductRoot(options.productRoot, errors)
      if (physicalProductRoot) {
        productAssets = await inspectAssetDirectory(
          physicalProductRoot,
          PRODUCT_RELATIVE_ROOT,
          'product',
          errors,
        )
      }
    }

    for (const expected of EXPECTED_PAIRS) {
      const entry = entriesByKey.get(expected.key)
      const publicAsset = publicAssets.get(expected.filename)
      const bundledAsset = bundledAssets.get(expected.filename)
      const productAsset = options.productRoot === null
        ? null
        : productAssets.get(expected.filename)
      if (entry && publicAsset) {
        if (publicAsset.byteSize !== entry.byteSize) errors.push(`public byte-size mismatch: ${expected.key}`)
        if (publicAsset.sha256 !== entry.sha256) errors.push(`public checksum mismatch: ${expected.key}`)
      }
      if (entry && bundledAsset) {
        if (bundledAsset.byteSize !== entry.byteSize) errors.push(`bundle byte-size mismatch: ${expected.key}`)
        if (bundledAsset.sha256 !== entry.sha256) errors.push(`bundle checksum mismatch: ${expected.key}`)
      }
      if (publicAsset && bundledAsset) {
        if (!publicAsset.bytes.equals(bundledAsset.bytes)) {
          errors.push(`public/bundle copy mismatch: ${expected.key}`)
        } else if (entry) {
          probeBundledMedia(bundledAsset, entry, expected.key, options.release, errors)
        }
      }
      if (options.productRoot !== null && entry && productAsset) {
        if (productAsset.byteSize !== entry.byteSize) errors.push(`product byte-size mismatch: ${expected.key}`)
        if (productAsset.sha256 !== entry.sha256) errors.push(`product checksum mismatch: ${expected.key}`)
        if (bundledAsset && !productAsset.bytes.equals(bundledAsset.bytes)) {
          errors.push(`bundle/product copy mismatch: ${expected.key}`)
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Voice preview catalog FAIL (${errors.length})`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  const approved = manifest.entries.filter((entry) => entry.approved === true).length
  console.log(
    `Voice preview catalog PASS: 12/12 pairs, 12/12 generated+verified, `
      + `${approved}/12 owner-approved, release=${options.release}`,
  )
}

await main()
