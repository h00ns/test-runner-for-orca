import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ProjectSpec } from './projects.ts'
import { descendantsOf, startRun } from './run.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readOr(file: string, fallback: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

test('finds every process below one, however deep', () => {
  const listing = ['  1     0', ' 10     1', ' 11    10', ' 12    11', ' 13    10', ' 20     1', ''].join('\n')
  assert.deepEqual(
    descendantsOf(10, listing).sort((a, b) => a - b),
    [11, 12, 13]
  )
  assert.deepEqual(descendantsOf(99, listing), [])
})

test('stopping a run also stops what the runner started in its own process group', { skip: process.platform === 'win32' }, async () => {
  // A stand-in for Playwright: a "python" that starts a server in a new process group, as
  // Playwright does with its web server, and would leave it running if it were killed.
  const cwd = mkdtempSync(join(tmpdir(), 'orca-test-runner-stop-'))
  dirs.push(cwd)
  mkdirSync(join(cwd, '.venv', 'bin'), { recursive: true })
  const pidFile = join(cwd, 'server.pid')
  const python = join(cwd, '.venv', 'bin', 'python')
  writeFileSync(
    python,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process')",
      "const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(server.pid))`,
      "process.on('SIGINT', () => process.exit(130))",
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  chmodSync(python, 0o755)
  const project: ProjectSpec = {
    id: '.:pytest',
    name: 'pytest',
    root: '',
    runner: 'pytest',
    e2e: false,
    cwd,
    entry: null,
    args: [],
    env: {},
    autoRun: true
  }
  const run = startRun(project, { scope: 'all' }, 60_000, cwd)
  let server = 0
  for (let i = 0; i < 100 && !server; i++) {
    await wait(50)
    server = Number(readOr(pidFile, '0'))
  }
  assert.ok(server && isAlive(server), 'the stand-in started its server')
  run.cancel()
  assert.equal((await run.done).kind, 'error')
  await wait(200)
  assert.equal(isAlive(server), false, 'the server in its own process group was stopped too')
})
