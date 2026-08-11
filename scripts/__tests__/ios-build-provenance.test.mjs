import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'ios-build-provenance.sh')
const xcodeProject = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ios',
  'App',
  'App.xcodeproj',
  'project.pbxproj',
)
const expectedPaths = [
  'ios/App/App/capacitor.config.json',
  'ios/App/App/config.xml',
  'ios/App/App/public/cordova.js',
  'ios/App/App/public/cordova_plugins.js',
  'ios/App/App/public/index.html',
]

const fixtureRoots = new Set()

test.after(() => {
  for (const fixtureRoot of fixtureRoots) {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ALMA Provenance Test',
      GIT_AUTHOR_EMAIL: 'provenance@example.invalid',
      GIT_COMMITTER_NAME: 'ALMA Provenance Test',
      GIT_COMMITTER_EMAIL: 'provenance@example.invalid',
      ...options.env,
    },
  })
  return result
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options)
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
  return result
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function readFileNames(path) {
  return readdirSync(path).sort()
}

function provenanceArtifacts(path) {
  return readFileNames(path).filter((name) => name.startsWith('alma-build-provenance.plist'))
}

function makeManifest(repositoryRoot) {
  return expectedPaths
    .map((path) => `${sha256(readFileSync(join(repositoryRoot, path)))}  ${path}`)
    .join('\n') + '\n'
}

function createFixture({ objectFormat = 'sha1', manifestTransform } = {}) {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'alma-ios-provenance-')))
  fixtureRoots.add(fixtureRoot)
  const repositoryRoot = join(fixtureRoot, 'repository')
  const productRoot = join(fixtureRoot, 'product', 'Alma.app')
  const output = join(productRoot, 'alma-build-provenance.plist')
  const manifest = join(repositoryRoot, 'ios/App/BuildSupport/alma-bundled-inputs.sha256')

  mkdirSync(repositoryRoot, { recursive: true })
  mustRun('git', ['init', `--object-format=${objectFormat}`, repositoryRoot])

  const contents = new Map([
    ['ios/App/App/capacitor.config.json', '{"appId":"com.almatraders.erp"}\n'],
    ['ios/App/App/config.xml', '<widget id="com.almatraders.erp"/>\n'],
    ['ios/App/App/public/cordova.js', '/* intentionally empty fixture */\n'],
    ['ios/App/App/public/cordova_plugins.js', '/* no plugins in fixture */\n'],
    ['ios/App/App/public/index.html', '<!doctype html><title>ALMA bootstrap</title>\n'],
  ])

  for (const [path, value] of contents) write(join(repositoryRoot, path), value)
  write(join(repositoryRoot, 'mobile/www/index.html'), contents.get('ios/App/App/public/index.html'))
  write(
    join(repositoryRoot, '.gitignore'),
    [
      '/ios/App/App/capacitor.config.json',
      '/ios/App/App/config.xml',
      '/ios/App/App/public/',
      '',
    ].join('\n'),
  )
  write(join(repositoryRoot, 'README.md'), 'clean tracked fixture\n')
  write(join(repositoryRoot, 'ios/App/App/TrackedAppSource.swift'), 'let fixtureValue = 1\n')

  let manifestContents = makeManifest(repositoryRoot)
  if (manifestTransform) manifestContents = manifestTransform(manifestContents)
  write(manifest, manifestContents)

  for (const path of expectedPaths) {
    const productRelative = path.replace(/^ios\/App\/App\//, '')
    const destination = join(productRoot, productRelative)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(repositoryRoot, path), destination)
  }

  mustRun('git', [
    '-C', repositoryRoot,
    'add',
    '.gitignore',
    'README.md',
    'ios/App/App/TrackedAppSource.swift',
    'mobile/www/index.html',
    relative(repositoryRoot, manifest),
  ])
  mustRun('git', ['-C', repositoryRoot, 'commit', '-m', 'fixture'])
  assert.equal(mustRun('git', ['-C', repositoryRoot, 'status', '--porcelain']).stdout, '')

  return { fixtureRoot, repositoryRoot, productRoot, output, manifest }
}

function invoke(fixture, extra = [], { sourceOnly = false, env } = {}) {
  const args = [
    '--repository-root', fixture.repositoryRoot,
    '--manifest', fixture.manifest,
    '--output', fixture.output,
  ]
  if (sourceOnly) args.push('--source-only')
  else args.push('--product-root', fixture.productRoot)
  args.push(...extra)
  return run(script, args, { env })
}

function parsePlist(path) {
  const xml = readFileSync(path, 'utf8')
  const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])
  const schema = xml.match(/<key>schemaVersion<\/key>\s*<integer>([^<]+)<\/integer>/)?.[1]
  const status = xml.match(/<key>revisionStatus<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  const commit = xml.match(/<key>commit<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  return { xml, keys, schema, status, commit }
}

function assertUnavailable(fixture, expectedStatus) {
  const plist = parsePlist(fixture.output)
  assert.equal(plist.schema, '1')
  assert.equal(plist.status, expectedStatus)
  assert.equal(plist.commit, undefined)
  assert.deepEqual(plist.keys, ['schemaVersion', 'revisionStatus'])
  return plist
}

test('verified product build emits only schema, closed status, and a full lowercase commit', () => {
  const fixture = createFixture()
  const result = invoke(fixture)
  assert.equal(result.status, 0, result.stderr)

  const plist = parsePlist(fixture.output)
  const head = mustRun('git', ['-C', fixture.repositoryRoot, 'rev-parse', 'HEAD']).stdout.trim()
  assert.deepEqual(plist.keys, ['schemaVersion', 'revisionStatus', 'commit'])
  assert.equal(plist.schema, '1')
  assert.equal(plist.status, 'verified-clean-source-and-bundled-inputs')
  assert.equal(plist.commit, head)
  assert.match(plist.commit, /^[0-9a-f]{40}$/)

  for (const forbidden of [
    fixture.repositoryRoot,
    fixture.productRoot,
    'capacitor.config.json',
    'index.html',
    'dirty-file.swift',
    'createdAt',
    'timestamp',
  ]) {
    assert.equal(plist.xml.includes(forbidden), false, `plist leaked ${forbidden}`)
  }
  for (const path of expectedPaths) {
    assert.equal(plist.xml.includes(sha256(readFileSync(join(fixture.repositoryRoot, path)))), false)
  }
  assert.equal(lstatSync(fixture.output).isFile(), true)
})

test('source-only require-verified preflight succeeds without a product and supports SHA-256 Git commits', () => {
  const fixture = createFixture({ objectFormat: 'sha256' })
  rmSync(join(fixture.fixtureRoot, 'product'), { recursive: true, force: true })
  const result = invoke(fixture, ['--require-verified'], { sourceOnly: true })
  assert.equal(result.status, 0, result.stderr)
  const plist = parsePlist(fixture.output)
  assert.equal(plist.status, 'verified-clean-source-and-bundled-inputs')
  assert.match(plist.commit, /^[0-9a-f]{64}$/)
})

test('missing repository writes a valid unavailable plist and exits zero locally', () => {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'alma-ios-provenance-missing-')))
  fixtureRoots.add(fixtureRoot)
  const fixture = {
    repositoryRoot: join(fixtureRoot, 'does-not-exist'),
    manifest: join(fixtureRoot, 'does-not-exist', 'manifest.sha256'),
    output: join(fixtureRoot, 'result', 'alma-build-provenance.plist'),
  }
  const result = invoke(fixture, [], { sourceOnly: true })
  assert.equal(result.status, 0, result.stderr)
  assertUnavailable(fixture, 'unavailable-repository')
})

test('tracked, staged, and untracked dirtiness never emits a commit or file name', async (t) => {
  await t.test('tracked', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'README.md'), 'tracked dirty\n')
    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-dirty-worktree')
  })

  await t.test('staged', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'staged-owner-note.txt'), 'must not leak\n')
    mustRun('git', ['-C', fixture.repositoryRoot, 'add', 'staged-owner-note.txt'])
    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    const plist = assertUnavailable(fixture, 'unavailable-dirty-worktree')
    assert.equal(plist.xml.includes('staged-owner-note.txt'), false)
  })

  await t.test('untracked', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'dirty-owner-note.txt'), 'must not leak\n')
    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    const plist = assertUnavailable(fixture, 'unavailable-dirty-worktree')
    assert.equal(plist.xml.includes('dirty-owner-note.txt'), false)
  })
})

test('symlinked generated input is rejected as an untrusted path', () => {
  const fixture = createFixture()
  const source = join(fixture.repositoryRoot, expectedPaths[0])
  const external = join(fixture.fixtureRoot, 'external-capacitor-config.json')
  write(external, readFileSync(source))
  unlinkSync(source)
  symlinkSync(external, source)

  const result = invoke(fixture)
  assert.equal(result.status, 0, result.stderr)
  assertUnavailable(fixture, 'unavailable-untrusted-input-path')
})

test('repository root, manifest descendant, and generated public-root symlinks are untrusted', async (t) => {
  await t.test('repository root symlink', () => {
    const fixture = createFixture()
    const repositoryAlias = join(fixture.fixtureRoot, 'repository-alias')
    symlinkSync(fixture.repositoryRoot, repositoryAlias, 'dir')
    const result = invoke({
      ...fixture,
      repositoryRoot: repositoryAlias,
      manifest: join(repositoryAlias, 'ios/App/BuildSupport/alma-bundled-inputs.sha256'),
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })

  await t.test('manifest ancestor symlink', () => {
    const fixture = createFixture()
    const manifestAlias = join(fixture.repositoryRoot, 'manifest-alias')
    symlinkSync(join(fixture.repositoryRoot, 'ios/App/BuildSupport'), manifestAlias, 'dir')
    const result = invoke({
      ...fixture,
      manifest: join(manifestAlias, 'alma-bundled-inputs.sha256'),
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })

  await t.test('generated public root symlink', () => {
    const fixture = createFixture()
    const publicRoot = join(fixture.repositoryRoot, 'ios/App/App/public')
    const externalPublic = join(fixture.fixtureRoot, 'external-public')
    mkdirSync(externalPublic, { recursive: true })
    for (const name of ['cordova.js', 'cordova_plugins.js', 'index.html']) {
      copyFileSync(join(publicRoot, name), join(externalPublic, name))
    }
    rmSync(publicRoot, { recursive: true })
    symlinkSync(externalPublic, publicRoot, 'dir')
    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })
})

test('only the canonical regular manifest tracked in HEAD is trusted', async (t) => {
  await t.test('alternate tracked in-repository manifest', () => {
    const fixture = createFixture()
    const alternateManifest = join(fixture.repositoryRoot, 'ios/App/BuildSupport/alternate.sha256')
    copyFileSync(fixture.manifest, alternateManifest)
    mustRun('git', ['-C', fixture.repositoryRoot, 'add', relative(fixture.repositoryRoot, alternateManifest)])
    mustRun('git', ['-C', fixture.repositoryRoot, 'commit', '-m', 'add alternate manifest'])
    const result = invoke({ ...fixture, manifest: alternateManifest })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })

  await t.test('canonical manifest absent from HEAD', () => {
    const fixture = createFixture()
    mustRun('git', ['-C', fixture.repositoryRoot, 'rm', '--cached', relative(fixture.repositoryRoot, fixture.manifest)])
    mustRun('git', ['-C', fixture.repositoryRoot, 'commit', '-m', 'remove manifest from HEAD'])
    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })
})

test('hidden index flags cannot produce a verified revision', async (t) => {
  await t.test('assume-unchanged manifest is still compared byte-for-byte with HEAD', () => {
    const fixture = createFixture()
    mustRun('git', ['-C', fixture.repositoryRoot, 'update-index', '--assume-unchanged', relative(fixture.repositoryRoot, fixture.manifest)])
    write(join(fixture.repositoryRoot, expectedPaths[0]), '{"changed-and-rebound":true}\n')
    write(fixture.manifest, makeManifest(fixture.repositoryRoot))
    assert.equal(mustRun('git', ['-C', fixture.repositoryRoot, 'status', '--porcelain']).stdout, '')

    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('assume-unchanged tracked app source marks the full repository dirty', () => {
    const fixture = createFixture()
    const appSource = 'ios/App/App/TrackedAppSource.swift'
    mustRun('git', ['-C', fixture.repositoryRoot, 'update-index', '--assume-unchanged', appSource])
    write(join(fixture.repositoryRoot, appSource), 'let fixtureValue = 2\n')
    assert.equal(mustRun('git', ['-C', fixture.repositoryRoot, 'status', '--porcelain']).stdout, '')

    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-dirty-worktree')
  })

  await t.test('skip-worktree tracked app source marks the full repository dirty', () => {
    const fixture = createFixture()
    const appSource = 'ios/App/App/TrackedAppSource.swift'
    mustRun('git', ['-C', fixture.repositoryRoot, 'update-index', '--skip-worktree', appSource])
    write(join(fixture.repositoryRoot, appSource), 'let fixtureValue = 3\n')
    assert.equal(mustRun('git', ['-C', fixture.repositoryRoot, 'status', '--porcelain']).stdout, '')

    const result = invoke(fixture)
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-dirty-worktree')
  })
})

test('manifest checksum, exact public set, and bootstrap byte mismatch fail source verification', async (t) => {
  await t.test('checksum mismatch', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, expectedPaths[0]), '{"changed":true}\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('missing generated source', () => {
    const fixture = createFixture()
    unlinkSync(join(fixture.repositoryRoot, expectedPaths[1]))
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('extra public file', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'ios/App/App/public/not-in-manifest.js'), 'extra\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('bootstrap mismatch', () => {
    const fixture = createFixture()
    const index = join(fixture.repositoryRoot, 'ios/App/App/public/index.html')
    write(index, '<!doctype html><title>different ignored bootstrap</title>\n')
    const updatedManifest = makeManifest(fixture.repositoryRoot)
    write(fixture.manifest, updatedManifest)
    mustRun('git', ['-C', fixture.repositoryRoot, 'add', relative(fixture.repositoryRoot, fixture.manifest)])
    mustRun('git', ['-C', fixture.repositoryRoot, 'commit', '-m', 'update generated-input manifest only'])
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('noncanonical manifest order', () => {
    const fixture = createFixture({
      manifestTransform: (manifest) => manifest.trimEnd().split('\n').reverse().join('\n') + '\n',
    })
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })
})

test('copied-product bytes and public set must exactly match the manifest', async (t) => {
  await t.test('product byte mismatch', () => {
    const fixture = createFixture()
    write(join(fixture.productRoot, 'capacitor.config.json'), '{"wrong-product-copy":true}\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-product-copy-mismatch')
  })

  await t.test('extra product public file', () => {
    const fixture = createFixture()
    write(join(fixture.productRoot, 'public/extra.js'), 'extra\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-product-copy-mismatch')
  })

  await t.test('missing product root', () => {
    const fixture = createFixture()
    rmSync(fixture.productRoot, { recursive: true })
    const result = invoke(fixture, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(existsSync(fixture.output), false)
  })

  await t.test('product file symlink', () => {
    const fixture = createFixture()
    const productFile = join(fixture.productRoot, 'config.xml')
    const external = join(fixture.fixtureRoot, 'external-product-config.xml')
    copyFileSync(productFile, external)
    unlinkSync(productFile)
    symlinkSync(external, productFile)
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-product-copy-mismatch')
  })

  await t.test('product root symlink', () => {
    const fixture = createFixture()
    const realProduct = join(fixture.fixtureRoot, 'real-product')
    const productParent = dirname(fixture.productRoot)
    mkdirSync(realProduct, { recursive: true })
    for (const path of expectedPaths) {
      const productRelative = path.replace(/^ios\/App\/App\//, '')
      const destination = join(realProduct, productRelative)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(fixture.repositoryRoot, path), destination)
    }
    rmSync(productParent, { recursive: true })
    mkdirSync(productParent, { recursive: true })
    symlinkSync(realProduct, fixture.productRoot, 'dir')
    const result = invoke(fixture, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.deepEqual(provenanceArtifacts(realProduct), [])
  })
})

test('product mode binds output to one physical non-symlink product root', async (t) => {
  await t.test('wrong output filename inside product root is rejected', () => {
    const fixture = createFixture()
    const wrongOutput = join(fixture.productRoot, 'other-provenance.plist')
    const result = invoke({ ...fixture, output: wrongOutput }, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(existsSync(wrongOutput), false)
  })

  await t.test('output outside product root is rejected', () => {
    const fixture = createFixture()
    const outsideParent = join(fixture.fixtureRoot, 'outside-output')
    mkdirSync(outsideParent, { recursive: true })
    const outsideOutput = join(outsideParent, 'alma-build-provenance.plist')
    const result = invoke({ ...fixture, output: outsideOutput }, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(existsSync(outsideOutput), false)
  })

  await t.test('product-root ancestor symlink is rejected', () => {
    const fixture = createFixture()
    const realProductParent = dirname(fixture.productRoot)
    const aliasParent = join(fixture.fixtureRoot, 'product-parent-alias')
    symlinkSync(realProductParent, aliasParent, 'dir')
    const aliasedRoot = join(aliasParent, 'Alma.app')
    const aliasedOutput = join(aliasedRoot, 'alma-build-provenance.plist')
    const result = invoke({ ...fixture, productRoot: aliasedRoot, output: aliasedOutput }, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.deepEqual(provenanceArtifacts(fixture.productRoot), [])
  })
})

test('public traversal and checksum-read failures are checked for source and copied product', async (t) => {
  await t.test('source find failure becomes a bundled-input mismatch', () => {
    const fixture = createFixture()
    const wrapperDirectory = join(fixture.fixtureRoot, 'source-find-wrapper')
    const wrapper = join(wrapperDirectory, 'find')
    mkdirSync(wrapperDirectory, { recursive: true })
    write(wrapper, '#!/bin/bash\nexit 42\n')
    chmodSync(wrapper, 0o755)

    const result = invoke(fixture, [], {
      env: { PATH: `${wrapperDirectory}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('product find failure becomes a product-copy mismatch', () => {
    const fixture = createFixture()
    const wrapperDirectory = join(fixture.fixtureRoot, 'product-find-wrapper')
    const wrapper = join(wrapperDirectory, 'find')
    const realFind = mustRun('which', ['find']).stdout.trim()
    mkdirSync(wrapperDirectory, { recursive: true })
    write(
      wrapper,
      `#!/bin/bash
set -euo pipefail
if [[ "$1" == "$ALMA_TEST_PRODUCT_PUBLIC" ]]; then
  exit 42
fi
exec "$ALMA_TEST_REAL_FIND" "$@"
`,
    )
    chmodSync(wrapper, 0o755)

    const result = invoke(fixture, [], {
      env: {
        PATH: `${wrapperDirectory}:${process.env.PATH}`,
        ALMA_TEST_PRODUCT_PUBLIC: join(fixture.productRoot, 'public'),
        ALMA_TEST_REAL_FIND: realFind,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-product-copy-mismatch')
  })

  await t.test('source checksum read failure becomes a bundled-input mismatch', () => {
    const fixture = createFixture()
    const wrapperDirectory = join(fixture.fixtureRoot, 'source-shasum-wrapper')
    const wrapper = join(wrapperDirectory, 'shasum')
    mkdirSync(wrapperDirectory, { recursive: true })
    write(wrapper, '#!/bin/bash\nexit 42\n')
    chmodSync(wrapper, 0o755)

    const result = invoke(fixture, [], {
      env: { PATH: `${wrapperDirectory}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('product checksum read failure becomes a product-copy mismatch', () => {
    const fixture = createFixture()
    const wrapperDirectory = join(fixture.fixtureRoot, 'product-shasum-wrapper')
    const wrapper = join(wrapperDirectory, 'shasum')
    const realShasum = mustRun('which', ['shasum']).stdout.trim()
    mkdirSync(wrapperDirectory, { recursive: true })
    write(
      wrapper,
      `#!/bin/bash
set -euo pipefail
if [[ "$3" == "$ALMA_TEST_PRODUCT_CONFIG" ]]; then
  exit 42
fi
exec "$ALMA_TEST_REAL_SHASUM" "$@"
`,
    )
    chmodSync(wrapper, 0o755)

    const result = invoke(fixture, [], {
      env: {
        PATH: `${wrapperDirectory}:${process.env.PATH}`,
        ALMA_TEST_PRODUCT_CONFIG: join(fixture.productRoot, 'capacitor.config.json'),
        ALMA_TEST_REAL_SHASUM: realShasum,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assertUnavailable(fixture, 'unavailable-product-copy-mismatch')
  })
})

test('status precedence is source trust/content, then Git dirtiness, then product copy', async (t) => {
  await t.test('source symlink outranks dirty Git', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'dirty.txt'), 'dirty\n')
    const source = join(fixture.repositoryRoot, expectedPaths[0])
    const external = join(fixture.fixtureRoot, 'external.json')
    copyFileSync(source, external)
    unlinkSync(source)
    symlinkSync(external, source)
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-untrusted-input-path')
  })

  await t.test('source mismatch outranks dirty Git', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'dirty.txt'), 'dirty\n')
    write(join(fixture.repositoryRoot, expectedPaths[0]), '{"mismatch":true}\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-bundled-input-mismatch')
  })

  await t.test('dirty Git outranks product mismatch', () => {
    const fixture = createFixture()
    write(join(fixture.repositoryRoot, 'dirty.txt'), 'dirty\n')
    write(join(fixture.productRoot, 'config.xml'), '<wrong/>\n')
    assert.equal(invoke(fixture).status, 0)
    assertUnavailable(fixture, 'unavailable-dirty-worktree')
  })
})

test('require-verified writes valid no-commit plists for every unavailable class before failing', async (t) => {
  const cases = [
    {
      name: 'repository',
      status: 'unavailable-repository',
      prepare() {
        const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'alma-ios-provenance-require-missing-')))
        fixtureRoots.add(fixtureRoot)
        return {
          repositoryRoot: join(fixtureRoot, 'missing'),
          manifest: join(fixtureRoot, 'missing/manifest.sha256'),
          output: join(fixtureRoot, 'output/provenance.plist'),
        }
      },
      sourceOnly: true,
    },
    {
      name: 'untrusted source',
      status: 'unavailable-untrusted-input-path',
      prepare() {
        const fixture = createFixture()
        const source = join(fixture.repositoryRoot, expectedPaths[0])
        const external = join(fixture.fixtureRoot, 'outside.json')
        copyFileSync(source, external)
        unlinkSync(source)
        symlinkSync(external, source)
        return fixture
      },
    },
    {
      name: 'source mismatch',
      status: 'unavailable-bundled-input-mismatch',
      prepare() {
        const fixture = createFixture()
        write(join(fixture.repositoryRoot, expectedPaths[0]), '{"mismatch":true}\n')
        return fixture
      },
    },
    {
      name: 'product mismatch',
      status: 'unavailable-product-copy-mismatch',
      prepare() {
        const fixture = createFixture()
        write(join(fixture.productRoot, 'config.xml'), '<wrong/>\n')
        return fixture
      },
    },
  ]

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, () => {
      const fixture = fixtureCase.prepare()
      const result = invoke(fixture, ['--require-verified'], { sourceOnly: fixtureCase.sourceOnly })
      assert.notEqual(result.status, 0)
      assertUnavailable(fixture, fixtureCase.status)
    })
  }
})

test('a clean HEAD change between snapshots is detected without a production test hook', () => {
  const fixture = createFixture()
  const wrapperDirectory = join(fixture.fixtureRoot, 'git-wrapper')
  const wrapper = join(wrapperDirectory, 'git')
  const counter = join(fixture.fixtureRoot, 'git-status-count')
  const realGit = mustRun('which', ['git']).stdout.trim()
  mkdirSync(wrapperDirectory, { recursive: true })
  write(
    wrapper,
    `#!/bin/bash
set -euo pipefail
if [[ " $* " == *" status --porcelain=v1 "* ]]; then
  count=0
  [[ ! -f "$ALMA_TEST_GIT_COUNTER" ]] || count=$(<"$ALMA_TEST_GIT_COUNTER")
  count=$((count + 1))
  printf '%s\\n' "$count" > "$ALMA_TEST_GIT_COUNTER"
  if [[ "$count" -eq 2 ]]; then
    "$ALMA_TEST_REAL_GIT" -C "$ALMA_TEST_REPOSITORY" commit --allow-empty -m race >/dev/null
  fi
fi
exec "$ALMA_TEST_REAL_GIT" "$@"
`,
  )
  chmodSync(wrapper, 0o755)

  const result = run(script, [
    '--repository-root', fixture.repositoryRoot,
    '--manifest', fixture.manifest,
    '--product-root', fixture.productRoot,
    '--output', fixture.output,
  ], {
    env: {
      PATH: `${wrapperDirectory}:${process.env.PATH}`,
      ALMA_TEST_GIT_COUNTER: counter,
      ALMA_TEST_REAL_GIT: realGit,
      ALMA_TEST_REPOSITORY: fixture.repositoryRoot,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assertUnavailable(fixture, 'unavailable-dirty-worktree')
})

test('output path is atomically replaced only when the exact destination is regular', async (t) => {
  await t.test('existing regular plist is replaced and revalidated', () => {
    const fixture = createFixture()
    write(fixture.output, 'stale output\n')
    const result = invoke(fixture, ['--require-verified'])
    assert.equal(result.status, 0, result.stderr)
    const plist = parsePlist(fixture.output)
    assert.equal(plist.status, 'verified-clean-source-and-bundled-inputs')
    assert.equal(lstatSync(fixture.output).isFile(), true)
    assert.equal(lstatSync(fixture.output).isSymbolicLink(), false)
  })

  await t.test('existing output directory fails without moving a temp inside it', () => {
    const fixture = createFixture()
    mkdirSync(fixture.output, { recursive: true })
    const result = invoke(fixture, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(lstatSync(fixture.output).isDirectory(), true)
    assert.deepEqual(readFileNames(fixture.output), [])
  })

  await t.test('existing output symlink fails without writing into its directory target', () => {
    const fixture = createFixture()
    const targetDirectory = join(fixture.fixtureRoot, 'symlink-output-target')
    mkdirSync(dirname(fixture.output), { recursive: true })
    mkdirSync(targetDirectory, { recursive: true })
    symlinkSync(targetDirectory, fixture.output, 'dir')
    const result = invoke(fixture, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(lstatSync(fixture.output).isSymbolicLink(), true)
    assert.deepEqual(readFileNames(targetDirectory), [])
  })

  await t.test('existing FIFO output fails without blocking or claiming verified', () => {
    const fixture = createFixture()
    mkdirSync(dirname(fixture.output), { recursive: true })
    mustRun('mkfifo', [fixture.output])
    const result = invoke(fixture, ['--require-verified'])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.equal(lstatSync(fixture.output).isFIFO(), true)
  })

  await t.test('successful but ineffective mv is caught and its temp is cleaned', () => {
    const fixture = createFixture()
    const wrapperDirectory = join(fixture.fixtureRoot, 'mv-wrapper')
    const wrapper = join(wrapperDirectory, 'mv')
    mkdirSync(wrapperDirectory, { recursive: true })
    write(wrapper, '#!/bin/bash\nexit 0\n')
    chmodSync(wrapper, 0o755)

    const result = invoke(fixture, ['--require-verified'], {
      env: { PATH: `${wrapperDirectory}:${process.env.PATH}` },
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
    assert.deepEqual(provenanceArtifacts(dirname(fixture.output)), [])
  })
})

test('HUP, INT, and TERM clean temporary output and return conventional exit codes', async (t) => {
  for (const signalCase of [
    { signal: 'HUP', exitCode: 129 },
    { signal: 'INT', exitCode: 130 },
    { signal: 'TERM', exitCode: 143 },
  ]) {
    await t.test(signalCase.signal, () => {
      const fixture = createFixture()
      const wrapperDirectory = join(fixture.fixtureRoot, `signal-${signalCase.signal.toLowerCase()}-wrapper`)
      const wrapper = join(wrapperDirectory, 'mv')
      mkdirSync(wrapperDirectory, { recursive: true })
      write(
        wrapper,
        `#!/bin/bash
set -euo pipefail
/bin/kill -s "$ALMA_TEST_SIGNAL" "$PPID"
/bin/sleep 0.05
exit 0
`,
      )
      chmodSync(wrapper, 0o755)

      const result = invoke(fixture, ['--require-verified'], {
        env: {
          PATH: `${wrapperDirectory}:${process.env.PATH}`,
          ALMA_TEST_SIGNAL: signalCase.signal,
        },
      })
      assert.equal(result.signal, null)
      assert.equal(result.status, signalCase.exitCode, result.stderr)
      assert.equal(result.stdout.includes('verified-clean-source-and-bundled-inputs'), false)
      assert.deepEqual(provenanceArtifacts(dirname(fixture.output)), [])
    })
  }
})

test('script is executable and rejects ambiguous source/product CLI mode', () => {
  assert.equal((lstatSync(script).mode & 0o111) !== 0, true)
  const fixture = createFixture()
  const result = run(script, [
    '--repository-root', fixture.repositoryRoot,
    '--manifest', fixture.manifest,
    '--product-root', fixture.productRoot,
    '--output', fixture.output,
    '--source-only',
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /mutually exclusive/)
})

test('Xcode canonicalizes its existing app product before invoking provenance', () => {
  const project = readFileSync(xcodeProject, 'utf8')
  const phase = project.match(
    /C8A0D1000000000000000012 \/\* Generate Build Provenance \*\/ = \{[\s\S]*?\n\t\t\};/,
  )?.[0]

  assert.ok(phase, 'Generate Build Provenance phase is missing')
  assert.equal(
    phase.includes('PRODUCT_ROOT=\\"${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}\\"'),
    true,
  )
  assert.equal(
    phase.includes('PRODUCT_ROOT_PHYSICAL=$(cd \\"${PRODUCT_ROOT}\\" && pwd -P)'),
    true,
  )
  assert.equal(
    phase.includes('OUTPUT_PATH=\\"${PRODUCT_ROOT_PHYSICAL}/alma-build-provenance.plist\\"'),
    true,
  )
  assert.equal(phase.includes('--product-root \\"${PRODUCT_ROOT_PHYSICAL}\\"'), true)
  assert.equal(phase.includes('--output \\"${OUTPUT_PATH}\\"'), true)
  assert.equal(
    phase.includes('--product-root \\"${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}\\"'),
    false,
  )
})
