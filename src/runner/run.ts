// Runs vitest or jest once with a JSON report and reads it back.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnerKind } from '../protocol'
import type { DetectedRunner } from './detect'
import { resolveNode } from './detect'
import { parseReport, stripAnsi, type ParsedReport } from './report'

const OUTPUT_TAIL_CHARS = 8000
/** After the runner exits, how long to wait for processes it left holding its output. */
const EXIT_GRACE_MS = 2000
/** After SIGTERM, how long before SIGKILL. */
const KILL_GRACE_MS = 5000

export const CANCELLED = 'Cancelled.'

export type RunOutcome =
  | { kind: 'report'; report: ParsedReport }
  | { kind: 'error'; error: string; cancelled?: boolean }

export type RunHandle = { done: Promise<RunOutcome>; cancel: () => void }

export function runnerArgs(kind: RunnerKind, outputFile: string, files: readonly string[]): string[] {
  return kind === 'vitest'
    ? ['run', '--reporter=json', `--outputFile=${outputFile}`, '--passWithNoTests', ...files]
    : [
        '--json',
        `--outputFile=${outputFile}`,
        '--ci',
        '--passWithNoTests',
        // Why: a test that leaves a server or database handle open keeps Jest alive forever.
        '--forceExit',
        ...(files.length ? ['--runTestsByPath', ...files] : [])
      ]
}

/** Signals the runner's whole process group, even after the runner itself has exited: what it
 *  started (watchers, servers) can still be alive and holding its output open. */
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

function rootsOf(root: string): string[] {
  try {
    const real = realpathSync(root)
    return real === root ? [root] : [root, real]
  } catch {
    return [root]
  }
}

export function startRun(
  root: string,
  runner: DetectedRunner,
  files: readonly string[],
  timeoutMs: number
): RunHandle {
  const outputFile = join(tmpdir(), `orca-test-runner-${randomUUID()}.json`)
  const node = resolveNode()
  let tail = ''
  let stopped: 'cancelled' | 'timeout' | null = null
  let exitCode: number | null = null
  let finished = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let settle: (outcome: RunOutcome) => void = () => {}
  const done = new Promise<RunOutcome>((resolve) => (settle = resolve))

  const child = spawn(node.program, [runner.entry, ...runnerArgs(runner.kind, outputFile, files)], {
    cwd: root,
    env: { ...node.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
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
      void rm(outputFile, { force: true })
    }
  }

  async function outcome(spawnError?: Error): Promise<RunOutcome> {
    if (spawnError) {
      return { kind: 'error', error: `Could not start ${runner.kind}: ${spawnError.message}` }
    }
    if (stopped === 'cancelled') {
      return { kind: 'error', error: CANCELLED, cancelled: true }
    }
    const output = stripAnsi(tail).trim()
    let raw: string | null = null
    try {
      raw = await readFile(outputFile, 'utf8')
    } catch {
      raw = null
    }
    if (raw === null) {
      if (stopped === 'timeout') {
        return {
          kind: 'error',
          error: `Stopped after ${Math.round(timeoutMs / 60000)} min (the timeout in this plugin's settings).`
        }
      }
      return { kind: 'error', error: output || `${runner.kind} exited with code ${exitCode} and wrote no report.` }
    }
    let report: ParsedReport
    try {
      report = parseReport(JSON.parse(raw), rootsOf(root))
    } catch (error) {
      return { kind: 'error', error: `Could not read the ${runner.kind} report: ${String(error)}` }
    }
    // A runner that fails without a failing test: unhandled errors, coverage thresholds.
    if (report.failed === 0 && exitCode !== null && exitCode !== 0 && stopped === null) {
      return {
        kind: 'error',
        error: `${runner.kind} exited with code ${exitCode} although no test failed.\n\n${output}`.trim()
      }
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
