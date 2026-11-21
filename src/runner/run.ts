// Runs one project's runner once and reads its report back.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnerKind } from '../protocol.ts'
import { findOnPath, runnerEnv } from './detect.ts'
import { createLocator, parseJunit } from './junit.ts'
import type { ProjectSpec } from './projects.ts'
import { parseReport, stripAnsi, type ParsedReport } from './report.ts'

const OUTPUT_TAIL_CHARS = 8000
/** After the runner exits, how long to wait for processes it left holding its output. */
const EXIT_GRACE_MS = 2000
/** After SIGTERM, how long before SIGKILL. */
const KILL_GRACE_MS = 5000

export const CANCELLED = 'Cancelled.'

/** `files` are relative to the project folder; `changed` are absolute. */
export type RunMode = { scope: 'all' } | { scope: 'files'; files: string[] } | { scope: 'related'; changed: string[] }

export type RunOutcome =
  | { kind: 'report'; report: ParsedReport }
  | { kind: 'error'; error: string; cancelled?: boolean }

export type RunHandle = { done: Promise<RunOutcome>; cancel: () => void }

/** Runners that take test files as arguments, so failed tests can be re-run alone. */
export function runsFiles(kind: RunnerKind): boolean {
  return kind === 'vitest' || kind === 'jest' || kind === 'playwright' || kind === 'cypress' || kind === 'pytest'
}

/** Runners that can pick the tests importing given files. */
export function runsRelated(kind: RunnerKind): boolean {
  return kind === 'vitest' || kind === 'jest'
}

type ReportSource =
  | { kind: 'jest-json'; file: string }
  | { kind: 'junit-file'; file: string }
  | { kind: 'junit-dir'; dir: string }
  | { kind: 'junit-build'; marker: 'build/test-results' | 'target/surefire-reports' }

export type Invocation = { program: string; args: string[]; env: NodeJS.ProcessEnv; report: ReportSource }

function wrapper(cwd: string, unix: string, windows: string, fallback: string): { program: string; args: string[] } {
  if (process.platform === 'win32' && existsSync(join(cwd, windows))) {
    return { program: join(cwd, windows), args: [] }
  }
  if (existsSync(join(cwd, unix))) {
    // Through sh: a checkout can lose the wrapper's executable bit.
    return { program: 'sh', args: [unix] }
  }
  return { program: findOnPath(fallback) ?? fallback, args: [] }
}

function python(cwd: string): string {
  for (const dir of ['.venv', 'venv', 'env']) {
    const file = process.platform === 'win32' ? join(cwd, dir, 'Scripts', 'python.exe') : join(cwd, dir, 'bin', 'python')
    if (existsSync(file)) {
      return file
    }
  }
  return findOnPath('python3') ?? findOnPath('python') ?? 'python3'
}

/** The command for one project and mode, and where its report lands. Pure but for lookups. */
export function invocation(
  project: ProjectSpec,
  mode: RunMode,
  outDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): Invocation {
  const runtime = runnerEnv(baseEnv, execPath)
  const env: NodeJS.ProcessEnv = { ...runtime.env, ...project.env }
  // The node that starts JS runners: the user's, found once with the rest of the environment.
  const node = runtime.program
  const files = mode.scope === 'files' ? mode.files : []
  const changed = mode.scope === 'related' ? mode.changed : []
  switch (project.runner) {
    case 'vitest': {
      const file = join(outDir, 'report.json')
      const head = mode.scope === 'related' ? ['related', '--run', ...changed] : ['run', ...files]
      return {
        program: node,
        // Coverage off: thresholds fail every run that covers part of the suite.
        args: [project.entry!, ...head, '--reporter=json', `--outputFile=${file}`, '--passWithNoTests', '--coverage.enabled=false', ...project.args],
        env,
        report: { kind: 'jest-json', file }
      }
    }
    case 'jest': {
      const file = join(outDir, 'report.json')
      const pick =
        mode.scope === 'related' ? ['--findRelatedTests', ...changed] : files.length ? ['--runTestsByPath', ...files] : []
      return {
        program: node,
        // --forceExit: a test that leaves a server or database handle open keeps Jest alive forever.
        args: [project.entry!, '--json', `--outputFile=${file}`, '--ci', '--passWithNoTests', '--forceExit', '--coverage=false', ...project.args, ...pick],
        env,
        report: { kind: 'jest-json', file }
      }
    }
    case 'playwright': {
      const file = join(outDir, 'junit.xml')
      return {
        program: node,
        args: [project.entry!, 'test', '--reporter=junit', '--pass-with-no-tests', ...project.args, ...files],
        env: { ...env, PLAYWRIGHT_JUNIT_OUTPUT_NAME: file },
        report: { kind: 'junit-file', file }
      }
    }
    case 'cypress': {
      const dir = join(outDir, 'junit')
      return {
        program: node,
        args: [
          project.entry!,
          'run',
          '--reporter',
          'junit',
          '--reporter-options',
          `mochaFile=${join(dir, 'result-[hash].xml')},toConsole=false`,
          ...project.args,
          ...(files.length ? ['--spec', files.join(',')] : [])
        ],
        env,
        report: { kind: 'junit-dir', dir }
      }
    }
    case 'gradle': {
      const { program, args } = wrapper(project.cwd, 'gradlew', 'gradlew.bat', 'gradle')
      return {
        program,
        args: [...args, 'test', '--continue', '--console=plain', ...project.args],
        env,
        report: { kind: 'junit-build', marker: 'build/test-results' }
      }
    }
    case 'maven': {
      const { program, args } = wrapper(project.cwd, 'mvnw', 'mvnw.cmd', 'mvn')
      return {
        program,
        args: [...args, 'test', '-fae', '-B', ...project.args],
        env,
        report: { kind: 'junit-build', marker: 'target/surefire-reports' }
      }
    }
    case 'pytest': {
      const file = join(outDir, 'junit.xml')
      return {
        program: python(project.cwd),
        // xunit1 keeps each test's file and line in the report.
        args: ['-m', 'pytest', `--junitxml=${file}`, '-o', 'junit_family=xunit1', '-q', ...project.args, ...files],
        env,
        report: { kind: 'junit-file', file }
      }
    }
  }
}

/** Build-tool reports: TEST-*.xml in every build/test-results/<task>/ (Gradle) or
 *  target/surefire-reports/ (Maven), in the project and its modules. Only that level: TestNG
 *  also writes copies in subfolders, which would count its tests twice. */
function buildReports(cwd: string, marker: 'build/test-results' | 'target/surefire-reports', since: number): { fresh: string[]; all: string[] } {
  const fresh: string[] = []
  const all: string[] = []
  const take = (dir: string) => {
    for (const entry of safeDirents(dir)) {
      if (entry.isFile() && /^TEST-.*\.xml$/.test(entry.name)) {
        const file = join(dir, entry.name)
        all.push(file)
        if (statSync(file).mtimeMs >= since) {
          fresh.push(file)
        }
      }
    }
  }
  const visit = (moduleDir: string) => {
    const reports = join(moduleDir, marker)
    if (marker === 'target/surefire-reports') {
      take(reports)
    } else {
      for (const task of safeDirents(reports)) {
        if (task.isDirectory() && task.name !== 'binary') {
          take(join(reports, task.name))
        }
      }
    }
  }
  const walk = (dir: string, depth: number) => {
    visit(dir)
    if (depth >= 5) {
      return
    }
    for (const entry of safeDirents(dir)) {
      if (entry.isDirectory() && !['node_modules', 'src', 'build', 'target'].includes(entry.name) && !entry.name.startsWith('.')) {
        walk(join(dir, entry.name), depth + 1)
      }
    }
  }
  walk(cwd, 0)
  return { fresh, all }
}

function safeDirents(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Signals the runner's whole process group, even after the runner itself has exited: what it
 *  started (watchers, servers, browsers) can still be alive and holding its output open. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // The group is already gone.
  }
}

export function rootsOf(root: string): string[] {
  try {
    const real = realpathSync(root)
    return real === root ? [root] : [root, real]
  } catch {
    return [root]
  }
}

async function readReport(
  source: ReportSource,
  project: ProjectSpec,
  roots: string[],
  since: number,
  exitCode: number | null
): Promise<ParsedReport | null> {
  if (source.kind === 'jest-json') {
    const raw = await readFile(source.file, 'utf8').catch(() => null)
    return raw === null ? null : parseReport(JSON.parse(raw), roots)
  }
  let files: string[]
  if (source.kind === 'junit-file') {
    files = existsSync(source.file) ? [source.file] : []
  } else if (source.kind === 'junit-dir') {
    files = safeDirents(source.dir).filter((e) => e.isFile() && e.name.endsWith('.xml')).map((e) => join(source.dir, e.name))
  } else {
    const found = buildReports(project.cwd, source.marker, since - 1000)
    // An up-to-date Gradle test task rewrites nothing: its last reports still stand.
    files = found.fresh.length ? found.fresh : exitCode === 0 ? found.all : []
  }
  if (files.length === 0) {
    return null
  }
  const xmls = await Promise.all(files.map((file) => readFile(file, 'utf8').catch(() => '')))
  return parseJunit(xmls, { runner: project.runner, roots, locate: createLocator(project.cwd) })
}

/** Windows runs .bat and .cmd files only through cmd.exe; Node refuses to spawn them directly. */
export function windowsCommand(program: string, args: readonly string[]): { program: string; args: string[] } | null {
  if (process.platform !== 'win32' || !/\.(bat|cmd)$/i.test(program)) {
    return null
  }
  const quote = (arg: string) => (/^[\w.:\\/=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`)
  return { program: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${[program, ...args].map(quote).join(' ')}"`] }
}

function spawnRunner(call: Invocation, cwd: string): ChildProcess {
  const viaCmd = windowsCommand(call.program, call.args)
  return spawn(viaCmd?.program ?? call.program, viaCmd?.args ?? call.args, {
    cwd,
    env: call.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: !!viaCmd
  })
}

export function startRun(project: ProjectSpec, mode: RunMode, timeoutMs: number, workspaceRoot: string): RunHandle {
  const outDir = join(tmpdir(), `orca-test-runner-${randomUUID()}`)
  mkdirSync(outDir, { recursive: true })
  const call = invocation(project, mode, outDir)
  const startedAt = Date.now()
  let tail = ''
  let stopped: 'cancelled' | 'timeout' | null = null
  let exitCode: number | null = null
  let finished = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let settle: (outcome: RunOutcome) => void = () => {}
  const done = new Promise<RunOutcome>((resolve) => (settle = resolve))

  let child: ChildProcess
  try {
    child = spawnRunner(call, project.cwd)
  } catch (error) {
    void rm(outDir, { recursive: true, force: true })
    return {
      done: Promise.resolve({ kind: 'error', error: `Could not start ${project.runner}: ${(error as Error).message}` }),
      cancel: () => {}
    }
  }
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  async function finish(spawnError?: Error): Promise<void> {
    if (finished) {
      return
    }
    finished = true
    timers.forEach(clearTimeout)
    child.stdout?.destroy()
    child.stderr?.destroy()
    // Whatever the runner left behind goes now, so nothing outlives the run.
    signalGroup(child, 'SIGKILL')
    try {
      settle(await outcome(spawnError))
    } finally {
      void rm(outDir, { recursive: true, force: true })
    }
  }

  async function outcome(spawnError?: Error): Promise<RunOutcome> {
    if (spawnError) {
      const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
      return {
        kind: 'error',
        error: missing
          ? `Could not start ${project.runner}: "${call.program}" was not found. Install it or add it to PATH.`
          : `Could not start ${project.runner}: ${spawnError.message}`
      }
    }
    if (stopped === 'cancelled') {
      return { kind: 'error', error: CANCELLED, cancelled: true }
    }
    const output = stripAnsi(tail).trim()
    let report: ParsedReport | null
    try {
      report = await readReport(call.report, project, rootsOf(workspaceRoot), startedAt, exitCode)
    } catch (error) {
      return { kind: 'error', error: `Could not read the ${project.runner} report: ${String(error)}` }
    }
    if (!report) {
      if (stopped === 'timeout') {
        return { kind: 'error', error: `Stopped after ${Math.round(timeoutMs / 60000)} min (the timeout in this plugin's settings).` }
      }
      return { kind: 'error', error: output || `${project.runner} exited with code ${exitCode} and wrote no report.` }
    }
    // A runner that fails without a failing test: unhandled errors, coverage thresholds, a
    // module that did not compile.
    if (report.failed === 0 && exitCode !== null && exitCode !== 0 && stopped === null) {
      return { kind: 'error', error: `${project.runner} exited with code ${exitCode} although no test failed.\n\n${output}`.trim() }
    }
    return { kind: 'report', report }
  }

  function stop(reason: 'cancelled' | 'timeout'): void {
    if (finished) {
      return
    }
    stopped ??= reason
    signalGroup(child, 'SIGTERM')
    timers.push(setTimeout(() => void finish(), KILL_GRACE_MS))
  }

  timers.push(setTimeout(() => stop('timeout'), timeoutMs))
  child.once('error', (error) => void finish(error))
  child.once('exit', (code) => {
    exitCode = code
    // 'close' waits for every process holding the output; do not wait for it forever.
    timers.push(setTimeout(() => void finish(), EXIT_GRACE_MS))
  })
  child.once('close', () => void finish())

  return { done, cancel: () => stop('cancelled') }
}
