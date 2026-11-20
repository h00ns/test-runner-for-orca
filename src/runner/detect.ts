// Finds which test runner a workspace uses and the file to start it with.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { RunnerKind } from '../protocol'

export type DetectedRunner = { kind: RunnerKind; entry: string }

const BIN_NAME: Record<RunnerKind, string> = { vitest: 'vitest', jest: 'jest' }

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The runner named in package.json, vitest first when a project lists both. */
export function declaredRunner(pkg: Record<string, unknown> | null): RunnerKind | null {
  if (!pkg) {
    return null
  }
  const deps = {
    ...(pkg.dependencies as object | undefined),
    ...(pkg.devDependencies as object | undefined)
  } as Record<string, unknown>
  if ('vitest' in deps) {
    return 'vitest'
  }
  if ('jest' in deps) {
    return 'jest'
  }
  const script = typeof (pkg.scripts as Record<string, unknown> | undefined)?.test === 'string'
    ? ((pkg.scripts as Record<string, string>).test ?? '')
    : ''
  if (/\bvitest\b/.test(script)) {
    return 'vitest'
  }
  if (/\bjest\b/.test(script)) {
    return 'jest'
  }
  return null
}

/** The runner's JS entry from its own package.json `bin`, as the workspace would resolve it.
 *  Why not node_modules/.bin: pnpm and Windows put shell shims there, not scripts Node can run. */
export function resolveRunnerEntry(root: string, kind: RunnerKind): string | null {
  try {
    const require = createRequire(join(root, 'package.json'))
    const manifestPath = require.resolve(`${kind}/package.json`)
    const manifest = readJson(manifestPath)
    const bin = manifest?.bin
    const rel = typeof bin === 'string' ? bin : (bin as Record<string, string> | undefined)?.[BIN_NAME[kind]]
    if (!rel) {
      return null
    }
    const entry = join(dirname(manifestPath), rel)
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

export function detectRunner(root: string): DetectedRunner | null {
  const kind = declaredRunner(readJson(join(root, 'package.json')))
  if (!kind) {
    return null
  }
  const entry = resolveRunnerEntry(root, kind)
  return entry ? { kind, entry } : null
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
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin'
        ]
  return [...new Set([...fromPath, ...extra])]
}

export type NodeCommand = { program: string; env: NodeJS.ProcessEnv }

/** The user's `node`, else the runtime this worker runs on (Electron as Node when needed). */
export function resolveNode(env: NodeJS.ProcessEnv = process.env): NodeCommand {
  const dirs = candidateBinDirs(env)
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const found = dirs.map((dir) => join(dir, exe)).find((file) => existsSync(file))
  const PATH = dirs.join(delimiter)
  if (found) {
    return { program: found, env: { ...env, PATH: [dirname(found), PATH].join(delimiter) } }
  }
  return {
    program: process.execPath,
    env: { ...env, PATH, ELECTRON_RUN_AS_NODE: '1' }
  }
}
