// Turns a workspace into the projects to test: what `.orca-test-runner.json` lists, else every
// runner found at the root and in the monorepo's packages.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { ProjectInfo, RunnerKind } from '../protocol.ts'
import {
  declaredJsRunners,
  declaredOtherRunners,
  E2E_RUNNERS,
  hasRunnerConfig,
  JS_RUNNERS,
  readJson,
  resolveRunnerEntry,
  type JsRunner
} from './detect.ts'

export const CONFIG_FILE = '.orca-test-runner.json'
const MAX_PROJECTS = 40
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.turbo'])

export type ProjectSpec = ProjectInfo & {
  /** Absolute folder the runner runs in. */
  cwd: string
  /** The JS runner's entry file; null for Gradle, Maven and pytest. */
  entry: string | null
  args: string[]
  env: Record<string, string>
  /** Runs after an agent finishes. Defaults to true, false for browser tests. */
  autoRun: boolean
}

export type Discovery =
  | { kind: 'ok'; projects: ProjectSpec[]; configFile: boolean; autoRunScope: 'related' | 'all' | null }
  | { kind: 'config-error'; message: string }

type ConfigProject = { name?: string; root?: string; runner?: RunnerKind; args?: string[]; env?: Record<string, string>; autoRun?: boolean }
type Config = { autoRunScope?: 'related' | 'all'; env?: Record<string, string>; ignore?: string[]; projects?: ConfigProject[] }

const RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'playwright', 'cypress', 'gradle', 'maven', 'pytest'])

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/** The config's own problems, worded for the person who wrote it; null when it is fine. */
export function validateConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${CONFIG_FILE} must hold a JSON object.`
  }
  const config = raw as Record<string, unknown>
  const known = new Set(['$schema', 'autoRunScope', 'env', 'ignore', 'projects'])
  const unknown = Object.keys(config).find((key) => !known.has(key))
  if (unknown) {
    return `Unknown key "${unknown}" in ${CONFIG_FILE}.`
  }
  if (config.autoRunScope !== undefined && config.autoRunScope !== 'related' && config.autoRunScope !== 'all') {
    return '"autoRunScope" must be "related" or "all".'
  }
  if (config.env !== undefined && !isStringRecord(config.env)) {
    return '"env" must map names to strings.'
  }
  if (config.ignore !== undefined && !isStringArray(config.ignore)) {
    return '"ignore" must be a list of folders.'
  }
  if (config.projects !== undefined) {
    if (!Array.isArray(config.projects)) {
      return '"projects" must be a list.'
    }
    for (const [index, project] of config.projects.entries()) {
      const where = `projects[${index}]`
      if (!project || typeof project !== 'object') {
        return `${where} must be an object.`
      }
      const p = project as Record<string, unknown>
      const extra = Object.keys(p).find((key) => !['name', 'root', 'runner', 'args', 'env', 'autoRun'].includes(key))
      if (extra) {
        return `Unknown key "${extra}" in ${where}.`
      }
      if (p.root !== undefined && (typeof p.root !== 'string' || p.root.split(/[\\/]/).includes('..'))) {
        return `${where}.root must be a folder inside the workspace.`
      }
      if (p.runner !== undefined && (typeof p.runner !== 'string' || !RUNNERS.has(p.runner))) {
        return `${where}.runner must be one of ${[...RUNNERS].join(', ')}.`
      }
      if (p.args !== undefined && !isStringArray(p.args)) {
        return `${where}.args must be a list of strings.`
      }
      if (p.env !== undefined && !isStringRecord(p.env)) {
        return `${where}.env must map names to strings.`
      }
      if (p.autoRun !== undefined && typeof p.autoRun !== 'boolean') {
        return `${where}.autoRun must be true or false.`
      }
      if (p.name !== undefined && typeof p.name !== 'string') {
        return `${where}.name must be a string.`
      }
    }
  }
  return null
}

function normalizeRoot(root: string): string {
  const clean = posix.normalize(root.replace(/\\/g, '/')).replace(/^\.\/?|\/$/g, '')
  return clean === '.' ? '' : clean
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `packages/*`, `apps/**`, `tools/cli`: the folders a workspace glob names (no files). */
export function expandWorkspaceGlob(root: string, pattern: string): string[] {
  const parts = normalizeRoot(pattern).split('/').filter(Boolean)
  const out: string[] = []
  const walk = (rel: string, index: number, depth: number) => {
    if (out.length > 500) {
      return
    }
    if (index === parts.length) {
      out.push(rel)
      return
    }
    const part = parts[index]!
    const abs = join(root, rel)
    if (part === '**') {
      walk(rel, index + 1, depth)
      if (depth < 4) {
        for (const name of safeList(abs)) {
          if (!SKIP_DIRS.has(name) && !name.startsWith('.') && isDir(join(abs, name))) {
            walk(rel ? `${rel}/${name}` : name, index, depth + 1)
          }
        }
      }
      return
    }
    if (part.includes('*')) {
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
      for (const name of safeList(abs)) {
        if (re.test(name) && !SKIP_DIRS.has(name) && isDir(join(abs, name))) {
          walk(rel ? `${rel}/${name}` : name, index + 1, depth)
        }
      }
      return
    }
    if (isDir(join(abs, part))) {
      walk(rel ? `${rel}/${part}` : part, index + 1, depth)
    }
  }
  walk('', 0, 0)
  return out
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The monorepo's package globs: pnpm-workspace.yaml, then package.json `workspaces`. */
export function workspaceGlobs(root: string): string[] {
  const globs: string[] = []
  try {
    const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    let inPackages = false
    for (const line of yaml.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true
        continue
      }
      if (inPackages) {
        const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line)
        if (item) {
          globs.push(item[1]!.trim())
        } else if (/^\S/.test(line)) {
          inPackages = false
        }
      }
    }
  } catch {
    // Not a pnpm workspace.
  }
  const workspaces = readJson(join(root, 'package.json'))?.workspaces
  const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages
  if (Array.isArray(list)) {
    globs.push(...list.filter((g): g is string => typeof g === 'string'))
  }
  return [...new Set(globs)]
}

function packageName(dir: string, fallback: string): string {
  const name = readJson(join(dir, 'package.json'))?.name
  return typeof name === 'string' && name ? name : fallback
}

function spec(
  workspaceRoot: string,
  root: string,
  runner: RunnerKind,
  name: string,
  extra: Partial<Pick<ProjectSpec, 'args' | 'env' | 'autoRun'>> = {}
): ProjectSpec | null {
  const cwd = join(workspaceRoot, root)
  const isJs = (JS_RUNNERS as readonly string[]).includes(runner)
  const entry = isJs ? resolveRunnerEntry(cwd, runner as JsRunner) : null
  if (isJs && !entry) {
    return null
  }
  const e2e = E2E_RUNNERS.has(runner)
  return {
    id: `${root || '.'}:${runner}`,
    name,
    root,
    runner,
    e2e,
    cwd,
    entry,
    args: extra.args ?? [],
    env: extra.env ?? {},
    autoRun: extra.autoRun ?? !e2e
  }
}

/** A root config that runs the packages itself: a Vitest workspace or `projects`, Jest `projects`.
 *  A plain root config (a shared base the packages extend) does not. */
export function rootCoversPackages(dir: string, kind: JsRunner): boolean {
  const names = safeList(dir)
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  if (kind === 'vitest') {
    return (
      names.some((n) => /^vitest\.workspace\.[cm]?[jt]s(on)?$/.test(n)) ||
      names.filter((n) => /^vitest\.config\.[cm]?[jt]s$/.test(n)).some((n) => /\b(projects|workspace)\s*:/.test(read(n)))
    )
  }
  if (kind === 'jest') {
    const pkgJest = readJson(join(dir, 'package.json'))?.jest as { projects?: unknown } | undefined
    return !!pkgJest?.projects || names.filter((n) => /^jest\.config\./.test(n)).some((n) => /\bprojects\b/.test(read(n)))
  }
  return false
}

/** Arguments that keep a root run out of the packages that run on their own. */
function excludePackages(kind: RunnerKind, dirs: readonly string[]): string[] {
  if (dirs.length === 0) {
    return []
  }
  if (kind === 'vitest') {
    return dirs.flatMap((dir) => ['--exclude', `${dir}/**`])
  }
  if (kind === 'jest') {
    return ['--testPathIgnorePatterns', ...dirs.map((dir) => `<rootDir>/${dir}/`), '/node_modules/']
  }
  return []
}

/** Every runner at the root and in the workspace packages. */
export function autoDetect(workspaceRoot: string, ignore: readonly string[] = []): ProjectSpec[] {
  const ignored = new Set(ignore.map(normalizeRoot))
  const rootName = packageName(workspaceRoot, 'root')
  const rootJs = ignored.has('') ? [] : declaredJsRunners(workspaceRoot)
  const globs = workspaceGlobs(workspaceRoot)
  const excluded = new Set(globs.filter((g) => g.startsWith('!')).flatMap((g) => expandWorkspaceGlob(workspaceRoot, g.slice(1))))
  const packages = [...new Set(globs.filter((g) => !g.startsWith('!')).flatMap((g) => expandWorkspaceGlob(workspaceRoot, g)))]
    .filter((dir) => dir && !excluded.has(dir) && !ignored.has(dir) && existsSync(join(workspaceRoot, dir, 'package.json')))
    .sort()

  const covered = new Set(rootJs.filter((kind) => rootCoversPackages(workspaceRoot, kind)))
  const packageProjects: ProjectSpec[] = []
  for (const dir of packages) {
    const abs = join(workspaceRoot, dir)
    for (const kind of declaredJsRunners(abs)) {
      if (covered.has(kind)) {
        continue
      }
      const project = spec(workspaceRoot, dir, kind, packageName(abs, dir))
      if (project) {
        packageProjects.push(project)
      }
    }
    if (packageProjects.length >= MAX_PROJECTS) {
      break
    }
  }

  const rootProjects: ProjectSpec[] = []
  for (const kind of rootJs) {
    const own = packageProjects.filter((p) => p.runner === kind).map((p) => p.root)
    // A root that only installs the runner for its packages has nothing of its own to run.
    if (!covered.has(kind) && own.length > 0 && !hasRunnerConfig(workspaceRoot, kind)) {
      continue
    }
    const project = spec(workspaceRoot, '', kind, rootName, { args: excludePackages(kind, own) })
    if (project) {
      rootProjects.push(project)
    }
  }
  if (!ignored.has('')) {
    for (const kind of declaredOtherRunners(workspaceRoot)) {
      const project = spec(workspaceRoot, '', kind, rootName)
      if (project) {
        rootProjects.push(project)
      }
    }
  }
  return [...rootProjects, ...packageProjects].slice(0, MAX_PROJECTS)
}

export function discoverProjects(workspaceRoot: string): Discovery {
  const configPath = join(workspaceRoot, CONFIG_FILE)
  if (!existsSync(configPath)) {
    return { kind: 'ok', projects: autoDetect(workspaceRoot), configFile: false, autoRunScope: null }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    return { kind: 'config-error', message: `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}` }
  }
  const problem = validateConfig(raw)
  if (problem) {
    return { kind: 'config-error', message: problem }
  }
  const config = raw as Config
  const sharedEnv = config.env ?? {}
  let projects: ProjectSpec[]
  if (config.projects?.length) {
    projects = []
    for (const [index, entry] of config.projects.entries()) {
      const root = normalizeRoot(entry.root ?? '')
      const abs = join(workspaceRoot, root)
      if (!isDir(abs)) {
        return { kind: 'config-error', message: `projects[${index}].root "${entry.root}" is not a folder.` }
      }
      const runner = entry.runner ?? [...declaredJsRunners(abs), ...declaredOtherRunners(abs)][0]
      if (!runner) {
        return { kind: 'config-error', message: `projects[${index}]: no runner found in "${root || '.'}"; set "runner".` }
      }
      const project = spec(workspaceRoot, root, runner, entry.name ?? packageName(abs, root || 'root'), {
        args: entry.args,
        env: { ...sharedEnv, ...entry.env },
        autoRun: entry.autoRun
      })
      if (!project) {
        return { kind: 'config-error', message: `projects[${index}]: ${runner} is not installed in "${root || '.'}".` }
      }
      // Two configs of one runner in one folder (unit and e2e, say) are told apart by name.
      const id = projects.some((p) => p.id === project.id) ? `${project.id}#${entry.name ?? index}` : project.id
      if (projects.some((p) => p.id === id)) {
        return { kind: 'config-error', message: `projects[${index}] repeats ${runner} in "${root || '.'}"; give each a different "name".` }
      }
      projects.push({ ...project, id })
    }
  } else {
    projects = autoDetect(workspaceRoot, config.ignore).map((p) => ({ ...p, env: { ...sharedEnv } }))
  }
  return { kind: 'ok', projects, configFile: true, autoRunScope: config.autoRunScope ?? null }
}
