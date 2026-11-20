import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { CONFIG_FILE, discoverProjects, expandWorkspaceGlob, validateConfig, workspaceGlobs } from './projects.ts'

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

/** A workspace from a map of files; runners are installed at the root, as hoisting does. */
function workspace(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'projects-test-'))
  roots.push(root)
  const all: Record<string, unknown> = {
    'node_modules/vitest/package.json': { name: 'vitest', bin: { vitest: 'vitest.mjs' } },
    'node_modules/vitest/vitest.mjs': '',
    'node_modules/jest/package.json': { name: 'jest', bin: { jest: 'bin/jest.js' } },
    'node_modules/jest/bin/jest.js': '',
    'node_modules/@playwright/test/package.json': { name: '@playwright/test', bin: { playwright: 'cli.js' } },
    'node_modules/@playwright/test/cli.js': '',
    ...files
  }
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

function summary(root: string) {
  const found = discoverProjects(root)
  assert.equal(found.kind, 'ok')
  return found.kind === 'ok' ? found.projects.map((p) => [p.id, p.name, p.e2e, p.autoRun]) : []
}

test('a single package with vitest', () => {
  const root = workspace({ 'package.json': { name: 'app', devDependencies: { vitest: '^3' } } })
  assert.deepEqual(summary(root), [['.:vitest', 'app', false, true]])
})

test('a runner named only in the test script counts', () => {
  const root = workspace({ 'package.json': { name: 'app', scripts: { test: 'jest --coverage' } } })
  assert.deepEqual(summary(root), [['.:jest', 'app', false, true]])
})

test('a pnpm monorepo: one project per package and runner; a root that only hoists runs nothing', () => {
  const root = workspace({
    'package.json': { name: 'mono', private: true, devDependencies: { vitest: '^3', jest: '^29' } },
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - \"apps/*\"\n  - '!packages/ignored'\n",
    'packages/ui/package.json': { name: '@mono/ui', devDependencies: { vitest: '^3' } },
    'packages/ui/vitest.config.ts': '',
    'packages/api/package.json': { name: '@mono/api', devDependencies: { jest: '^29' } },
    'packages/ignored/package.json': { name: 'ignored', devDependencies: { vitest: '^3' } },
    'packages/no-tests/package.json': { name: 'no-tests' },
    'apps/web/package.json': { name: 'web', devDependencies: { vitest: '^3', '@playwright/test': '^1' } },
    'apps/web/playwright.config.ts': ''
  })
  assert.deepEqual(summary(root), [
    ['apps/web:vitest', 'web', false, true],
    ['apps/web:playwright', 'web', true, false],
    ['packages/api:jest', '@mono/api', false, true],
    ['packages/ui:vitest', '@mono/ui', false, true]
  ])
})

test('a root Vitest workspace covers the packages that use Vitest', () => {
  const root = workspace({
    'package.json': { name: 'mono', workspaces: ['packages/*'], devDependencies: { vitest: '^3' } },
    'vitest.workspace.ts': '',
    'packages/a/package.json': { name: 'a', devDependencies: { vitest: '^3' } },
    'packages/b/package.json': { name: 'b', devDependencies: { jest: '^29' } }
  })
  assert.deepEqual(summary(root), [
    ['.:vitest', 'mono', false, true],
    ['packages/b:jest', 'b', false, true]
  ])
})

test('package.json workspaces as an object, and ** globs', () => {
  const root = workspace({
    'package.json': { name: 'mono', workspaces: { packages: ['libs/**'] } },
    'libs/core/package.json': { name: 'core', devDependencies: { vitest: '^3' } },
    'libs/group/inner/package.json': { name: 'inner', devDependencies: { vitest: '^3' } }
  })
  assert.deepEqual(workspaceGlobs(root), ['libs/**'])
  assert.ok(expandWorkspaceGlob(root, 'libs/**').includes('libs/group/inner'))
  assert.deepEqual(summary(root).map((p) => p[0]), ['libs/core:vitest', 'libs/group/inner:vitest'])
})

test('Gradle, Maven and pytest at the root', () => {
  assert.deepEqual(summary(workspace({ 'settings.gradle.kts': '', 'build.gradle.kts': '' })), [['.:gradle', 'root', false, true]])
  assert.deepEqual(summary(workspace({ 'pom.xml': '<project/>' })), [['.:maven', 'root', false, true]])
  assert.deepEqual(summary(workspace({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' })), [['.:pytest', 'root', false, true]])
  assert.deepEqual(summary(workspace({ 'pyproject.toml': '[tool.black]\n' })), [])
})

test('a runner named but not installed is left out', () => {
  const root = workspace({ 'package.json': { name: 'app', devDependencies: { cypress: '^13' } } })
  assert.deepEqual(summary(root), [])
})

test(`${CONFIG_FILE} lists projects with args, env and autoRun`, () => {
  const root = workspace({
    'package.json': { name: 'app', devDependencies: { vitest: '^3' } },
    'e2e/package.json': { name: 'e2e', devDependencies: { '@playwright/test': '^1' } },
    [CONFIG_FILE]: {
      env: { TZ: 'UTC' },
      projects: [
        { name: 'unit', args: ['--config', 'vitest.unit.config.ts'], env: { NODE_ENV: 'test' } },
        { root: 'e2e', runner: 'playwright', autoRun: true }
      ]
    }
  })
  const found = discoverProjects(root)
  assert.equal(found.kind, 'ok')
  if (found.kind !== 'ok') return
  assert.equal(found.configFile, true)
  assert.deepEqual(
    found.projects.map((p) => [p.id, p.name, p.args, p.env, p.autoRun]),
    [
      ['.:vitest', 'unit', ['--config', 'vitest.unit.config.ts'], { TZ: 'UTC', NODE_ENV: 'test' }, true],
      ['e2e:playwright', 'e2e', [], { TZ: 'UTC' }, true]
    ]
  )
})

test(`${CONFIG_FILE} problems are explained`, () => {
  assert.match(validateConfig([]) ?? '', /JSON object/)
  assert.match(validateConfig({ project: [] }) ?? '', /Unknown key "project"/)
  assert.match(validateConfig({ projects: [{ root: '../x' }] }) ?? '', /inside the workspace/)
  assert.match(validateConfig({ projects: [{ runner: 'mocha' }] }) ?? '', /runner must be one of/)
  assert.match(validateConfig({ autoRunScope: 'some' }) ?? '', /"related" or "all"/)
  assert.equal(validateConfig({ autoRunScope: 'all', ignore: ['legacy'], projects: [{ root: 'a', autoRun: false }] }), null)

  const broken = workspace({ [CONFIG_FILE]: '{ nope' })
  assert.equal(discoverProjects(broken).kind, 'config-error')
  const missing = workspace({ [CONFIG_FILE]: { projects: [{ root: 'nowhere' }] } })
  const result = discoverProjects(missing)
  assert.ok(result.kind === 'config-error' && /not a folder/.test(result.message))
})

test(`${CONFIG_FILE} "ignore" drops folders from detection`, () => {
  const root = workspace({
    'package.json': { name: 'mono', workspaces: ['packages/*'] },
    'packages/a/package.json': { name: 'a', devDependencies: { vitest: '^3' } },
    'packages/legacy/package.json': { name: 'legacy', devDependencies: { jest: '^29' } },
    [CONFIG_FILE]: { ignore: ['packages/legacy'] }
  })
  assert.deepEqual(summary(root).map((p) => p[0]), ['packages/a:vitest'])
})

test('a plain root config does not cover the packages; the root run leaves their folders out', () => {
  const root = workspace({
    'package.json': { name: 'mono', workspaces: ['packages/*'], devDependencies: { vitest: '^3', jest: '^29' } },
    'vitest.config.ts': 'export default { test: { environment: "node" } }',
    'jest.config.js': "module.exports = { roots: ['<rootDir>/scripts'] }",
    'packages/a/package.json': { name: 'a', devDependencies: { vitest: '^3' } },
    'packages/b/package.json': { name: 'b', devDependencies: { jest: '^29' } }
  })
  const found = discoverProjects(root)
  assert.ok(found.kind === 'ok')
  if (found.kind !== 'ok') return
  assert.deepEqual(found.projects.map((p) => [p.id, p.args]), [
    ['.:vitest', ['--exclude', 'packages/a/**']],
    ['.:jest', ['--testPathIgnorePatterns', '<rootDir>/packages/b/', '/node_modules/']],
    ['packages/a:vitest', []],
    ['packages/b:jest', []]
  ])
})

test('a root config with projects covers the packages', () => {
  const root = workspace({
    'package.json': { name: 'mono', workspaces: ['packages/*'], devDependencies: { vitest: '^3' } },
    'vitest.config.ts': "export default { test: { projects: ['packages/*'] } }",
    'packages/a/package.json': { name: 'a', devDependencies: { vitest: '^3' } }
  })
  assert.deepEqual(summary(root).map((p) => p[0]), ['.:vitest'])
})

test(`${CONFIG_FILE}: two configs of one runner in one folder are told apart by name`, () => {
  const root = workspace({
    'package.json': { name: 'app', devDependencies: { vitest: '^3' } },
    [CONFIG_FILE]: { projects: [{ name: 'unit', args: ['-c', 'unit.ts'] }, { name: 'integration', args: ['-c', 'int.ts'] }] }
  })
  assert.deepEqual(summary(root).map((p) => [p[0], p[1]]), [['.:vitest', 'unit'], ['.:vitest#integration', 'integration']])
})

