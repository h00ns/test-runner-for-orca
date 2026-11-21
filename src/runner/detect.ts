// Finds runners in a folder, the files that start them, and `node`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { RunnerKind } from '../protocol.ts'

export const JS_RUNNERS = ['vitest', 'jest', 'playwright', 'cypress'] as const
export type JsRunner = (typeof JS_RUNNERS)[number]

/** The npm package that ships each JS runner, and the bin name to start it with. */
const PACKAGE: Record<JsRunner, { pkg: string; bin: string; configs: RegExp }> = {
  vitest: { pkg: 'vitest', bin: 'vitest', configs: /^vitest\.(config|workspace)\.[cm]?[jt]s$/ },
  jest: { pkg: 'jest', bin: 'jest', configs: /^jest\.config\.[cm]?[jt]s(on)?$/ },
  playwright: { pkg: '@playwright/test', bin: 'playwright', configs: /^playwright\.config\.[cm]?[jt]s$/ },
  cypress: { pkg: 'cypress', bin: 'cypress', configs: /^cypress\.config\.[cm]?[jt]s$/ }
}

export const E2E_RUNNERS: ReadonlySet<RunnerKind> = new Set(['playwright', 'cypress'])

export function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function dependencies(pkg: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...(pkg?.dependencies as object | undefined),
    ...(pkg?.devDependencies as object | undefined)
  } as Record<string, unknown>
}

/** A JS runner's config file sits in the folder (the runner may be hoisted to the root). */
export function hasRunnerConfig(dir: string, kind: JsRunner): boolean {
  if (kind === 'jest' && readJson(join(dir, 'package.json'))?.jest) {
    return true
  }
  return listDir(dir).some((name) => PACKAGE[kind].configs.test(name))
}

/** JS runners this folder uses: named in its package.json, or configured by a file in it. */
export function declaredJsRunners(dir: string): JsRunner[] {
  const pkg = readJson(join(dir, 'package.json'))
  if (!pkg) {
    return []
  }
  const deps = dependencies(pkg)
  const script = typeof (pkg.scripts as Record<string, unknown> | undefined)?.test === 'string'
    ? String((pkg.scripts as Record<string, string>).test)
    : ''
  return JS_RUNNERS.filter(
    (kind) =>
      PACKAGE[kind].pkg in deps ||
      hasRunnerConfig(dir, kind) ||
      (kind === 'vitest' && /\bvitest\b/.test(script)) ||
      (kind === 'jest' && /\bjest\b/.test(script))
  )
}

/** The runner's JS entry from its own package.json `bin`, as the folder would resolve it.
 *  Why not node_modules/.bin: pnpm and Windows put shell shims there, not scripts Node can run. */
export function resolveRunnerEntry(dir: string, kind: JsRunner): string | null {
  const { pkg, bin } = PACKAGE[kind]
  try {
    const require = createRequire(join(dir, 'package.json'))
    const manifestPath = require.resolve(`${pkg}/package.json`)
    const manifest = readJson(manifestPath)
    const field = manifest?.bin
    const rel = typeof field === 'string' ? field : (field as Record<string, string> | undefined)?.[bin]
    if (!rel) {
      return null
    }
    const entry = join(dirname(manifestPath), rel)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

/** JVM and Python runners, looked for at a project root only. */
export function declaredOtherRunners(dir: string): RunnerKind[] {
  const names = new Set(listDir(dir))
  const found: RunnerKind[] = []
  if (['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some((n) => names.has(n))) {
    found.push('gradle')
  } else if (names.has('pom.xml')) {
    found.push('maven')
  }
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  if (
    names.has('pytest.ini') ||
    (names.has('pyproject.toml') && /^\[tool\.pytest/m.test(read('pyproject.toml'))) ||
    (names.has('setup.cfg') && /^\[tool:pytest\]/m.test(read('setup.cfg'))) ||
    (names.has('tox.ini') && /^\[pytest\]/m.test(read('tox.ini'))) ||
    names.has('conftest.py')
  ) {
    found.push('pytest')
  }
  return found
}

/** Where version managers and installers put `node`; a GUI app's PATH often misses them. */
export function candidateBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir()
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra =
    process.platform === 'win32'
      ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')]
      : [
          join(home, '.volta', 'bin'),
          join(home, '.local', 'share', 'mise', 'shims'),
          join(home, '.asdf', 'shims'),
          join(home, '.sdkman', 'candidates', 'gradle', 'current', 'bin'),
          join(home, '.sdkman', 'candidates', 'maven', 'current', 'bin'),
          join(home, '.sdkman', 'candidates', 'java', 'current', 'bin'),
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin'
        ]
  return [...new Set([...fromPath, ...extra])]
}

/** The first executable named `name` in the PATH this plugin builds. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of candidateBinDirs(env)) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      if (existsSync(file)) {
        return file
      }
    }
  }
  return null
}

export type NodeCommand = { program: string; env: NodeJS.ProcessEnv }

/** The user's `node`; only without one, the runtime this worker runs on (Orca's Electron, as
 *  Node). Why the user's first: Orca's Electron cannot load unsigned native addons (rolldown,
 *  esbuild, swc), which most test toolchains need. Orca sets ELECTRON_RUN_AS_NODE for every
 *  plugin worker, so it is removed here unless Electron is really what runs the tests: a child
 *  that inherits it turns any Electron app the tests start into plain Node. */
export function resolveNode(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): NodeCommand {
  const PATH = candidateBinDirs(env).join(delimiter)
  const { ELECTRON_RUN_AS_NODE: _electron, ...rest } = env
  const found = findOnPath('node', env)
  if (found) {
    return { program: found, env: { ...rest, PATH: [dirname(found), PATH].join(delimiter) } }
  }
  return { program: execPath, env: { ...rest, PATH, ELECTRON_RUN_AS_NODE: '1' } }
}

/** The program and environment every runner gets: a PATH that finds node, java and friends. */
export function runnerEnv(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): NodeCommand {
  const node = resolveNode(env, execPath)
  return { program: node.program, env: { ...node.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } }
}
