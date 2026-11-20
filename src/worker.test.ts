// Runs src/worker.ts's activate(orca) over a mock host, against a temporary workspace whose
// "vitest" is a stub that writes a canned JSON report, so no real runner is needed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { PanelState, TestRun } from './protocol'
import * as main from './worker'
import { fitRun, workspaceKey } from './worker'

const KEY = workspaceKey('w1')

// The stub records its argv, then behaves as the STUB_* variables say.
const STUB_BIN = `
import { appendFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const out = process.argv.find((arg) => arg.startsWith('--outputFile='))?.slice('--outputFile='.length)
appendFileSync('runs.log', JSON.stringify(process.argv.slice(2)) + '\\n')
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)))
if (process.env.STUB_CRASH) { console.error('Error: failed to load vitest.config.ts'); process.exit(1) }
if (process.env.STUB_HANG_CHILD) {
  // A server a test left running: it holds our stdout, so 'close' would never come.
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
}
const finish = () => {
  copyFileSync('report.json', out)
  if (process.env.STUB_UNHANDLED) console.error('Vitest caught 1 unhandled error during the test run.')
  process.exit(Number(process.env.STUB_EXIT ?? 1))
}
setTimeout(finish, Number(process.env.STUB_DELAY_MS ?? 0))
`

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-runner-ws-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }))
  const pkg = join(root, 'node_modules', 'vitest')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: 'stub.mjs' } }))
  writeFileSync(join(pkg, 'stub.mjs'), STUB_BIN)
  return root
}

const failingReport = (root: string) => ({
  testResults: [
    {
      name: join(root, 'src/sum.test.ts'),
      status: 'failed',
      assertionResults: [
        { title: 'adds', ancestorTitles: ['sum'], status: 'passed', failureMessages: [] },
        {
          title: 'negatives',
          ancestorTitles: ['sum'],
          status: 'failed',
          failureMessages: [`AssertionError: expected 1 to be 2\n at ${join(root, 'src/sum.test.ts')}:7:5`]
        }
      ]
    }
  ]
})
const passingReport = (root: string) => ({
  testResults: [{ name: join(root, 'src/sum.test.ts'), status: 'passed', assertionResults: [{ title: 'adds', status: 'passed' }] }]
})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0)) {
    await step()
  }
})

function env(name: string, value: string) {
  process.env[name] = value
  cleanup.push(() => void delete process.env[name])
}

async function setupWorker(
  options: { agents?: unknown[]; report?: (root: string) => unknown; git?: boolean } = {}
) {
  const root = makeWorkspace()
  writeFileSync(join(root, 'report.json'), JSON.stringify((options.report ?? failingReport)(root)))
  if (options.git) {
    writeFileSync(join(root, '.gitignore'), 'node_modules\nruns.log\nargv.json\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'cart.ts'), 'export const a = 1\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  }
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'feature-x', path: root, branch: 'feature-x', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'remote', path: '/nowhere', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      },
      'agents.list': { agents: options.agents ?? [] },
      'terminal.sendText': { accepted: true },
      'terminal.focus': { focused: true },
      'agent.launch': { terminalId: 'new-term' },
      'editor.open': { opened: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host })
  cleanup.push(() => worker.deactivate(), () => rmSync(root, { recursive: true, force: true }))
  await focus(worker, 'w1')
  return { root, host, worker }
}

function focus(worker: TestWorker, workspaceId: string) {
  return worker.emit('workspace.changed', {
    context: { workspaceId, branch: 'feature-x', displayName: 'feature-x', terminals: [] }
  })
}

function runCount(root: string): number {
  try {
    return readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n').length
  } catch {
    return 0
  }
}

async function until(worker: TestWorker, done: (state: PanelState) => boolean, ms = 15_000): Promise<PanelState> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const last = [...worker.posts].reverse().find((post) => post.event === 'tests.changed')
    if (last && done(last.payload as PanelState)) {
      return last.payload as PanelState
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for tests.changed')
}

const finished = (s: PanelState) => s.running === null && s.lastRun !== null
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function agentDone(worker: TestWorker) {
  await worker.emit('agent.status.changed', {
    workspaceId: 'raw-w1',
    workspaceListId: 'w1',
    paneKey: 'tab:pane',
    state: 'done',
    receivedAt: Date.now()
  })
}

test('detects vitest and runs it with a JSON report', async () => {
  const { root, worker } = await setupWorker()
  const before = await worker.request('tests.state')
  assert.deepEqual(before.support, { kind: 'ok', runner: 'vitest' })
  assert.deepEqual(before.workspace, { name: 'feature-x', branch: 'feature-x' })
  assert.equal(before.workspaceKey, KEY)

  const started = await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  assert.equal(started.running?.scope, 'all')
  const state = await until(worker, finished)

  assert.equal(state.lastRun?.passed, 1)
  assert.equal(state.lastRun?.failed, 1)
  assert.equal(state.lastRun?.error, null)
  assert.deepEqual(
    state.lastRun?.failures.map((f) => [f.file, f.name, f.line]),
    [['src/sum.test.ts', 'sum › negatives', 7]]
  )
  const argv = JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[]
  assert.equal(argv[0], 'run')
  assert.ok(argv.includes('--reporter=json'))
  assert.deepEqual(worker.refusals, [])
})

test('re-runs only the files that failed', async () => {
  const { root, worker } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'failed' })
  await until(worker, (s) => s.running === null && s.lastRun?.scope === 'failed')
  const argv = JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8')) as string[]
  assert.equal(argv.at(-1), 'src/sum.test.ts')
})

test('shows what the runner printed when it writes no report', async () => {
  env('STUB_CRASH', '1')
  const { worker } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.match(state.lastRun?.error ?? '', /failed to load vitest\.config\.ts/)
})

test('a non-zero exit with no failing test is an error, not a pass', async () => {
  env('STUB_UNHANDLED', '1')
  const { worker } = await setupWorker({ report: passingReport })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.match(state.lastRun?.error ?? '', /exited with code 1 although no test failed[\s\S]*unhandled error/)
})

test('finishes even when something the runner started keeps its output open', async () => {
  env('STUB_HANG_CHILD', '1')
  const { worker } = await setupWorker()
  const started = Date.now()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished, 10_000)
  assert.equal(state.lastRun?.failed, 1)
  assert.ok(Date.now() - started < 8000, 'did not wait for the lingering process')
})

test('a second run request while one is starting is refused, not run twice', async () => {
  env('STUB_DELAY_MS', '500')
  const { root, worker } = await setupWorker()
  const results = await Promise.allSettled([
    worker.request('tests.run', { workspaceKey: KEY, scope: 'all' }),
    worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  await until(worker, finished)
  assert.equal(runCount(root), 1)
})

test('Stop cancels the run and the re-run queued behind it', async () => {
  env('STUB_DELAY_MS', '9000')
  const { root, worker } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await sleep(300)
  await agentDone(worker) // queued behind the running run after the debounce
  await sleep(3300)
  await worker.request('tests.cancel', { workspaceKey: KEY })
  await until(worker, (s) => s.running === null, 10_000)
  await sleep(3500)
  const state = await worker.request('tests.state')
  assert.equal(state.running, null)
  assert.equal(state.lastRun, null, 'a cancelled run leaves no result')
  assert.equal(runCount(root), 1)
})

test('sends a failure to the idle agent in the workspace', async () => {
  const { worker, host } = await setupWorker({
    agents: [
      { terminalId: 'busy', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 0 },
      { terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }
    ]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  const failureId = state.lastRun?.failures[0]?.id ?? ''

  const answer = await worker.request('tests.askAgent', { workspaceKey: KEY, failureId })
  assert.deepEqual(answer, { via: 'terminal', agent: 'Claude' })
  const [sent] = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
  assert.equal(sent?.terminalId, 't1')
  assert.equal(sent?.enter, true)
  assert.match(sent?.text ?? '', /"sum › negatives" in src\/sum\.test\.ts:7/)
  assert.ok(!(sent?.text ?? '').includes('\n'))
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: 'w1' }])
})

test('acts on the workspace the panel showed, even after focus moves', async () => {
  const { worker, host } = await setupWorker({
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  await focus(worker, 'w2')
  await worker.request('tests.askAgent', { workspaceKey: KEY })
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: 'w1' }])
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: 'gone' }), /no longer open/)
})

test('starts an agent when the workspace has none, and refuses a busy one', async () => {
  const { worker, host } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  assert.deepEqual(await worker.request('tests.askAgent', { workspaceKey: KEY }), { via: 'launch', agent: 'claude' })
  const [launch] = host.callsOf('agent.launch') as { agent: string; prompt: string }[]
  assert.equal(launch?.agent, 'claude')
  assert.match(launch?.prompt ?? '', /negatives/)

  host.respond('agents.list', {
    agents: [{ terminalId: 't9', title: 'Claude', agent: 'claude', state: 'blocked', stateStartedAt: 0 }]
  })
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: KEY }), /busy/)
})

test('opens the failing file in the editor', async () => {
  const { worker, host } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  await worker.request('tests.openFile', { workspaceKey: KEY, failureId: state.lastRun?.failures[0]?.id ?? '' })
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'w1', path: 'src/sum.test.ts' }])
})

test('runs on its own when an agent finishes, and notifies about failures once', async () => {
  const { worker, host, root } = await setupWorker({ git: true })
  await agentDone(worker)
  const state = await until(worker, (s) => s.running === null && s.lastRun?.trigger === 'agent-done')
  assert.equal(state.lastRun?.failed, 1)
  const [note] = host.callsOf('notifications.show') as { title: string }[]
  assert.equal(note?.title, '1 failing test in feature-x')

  // The agent edits again, the same test still fails: it runs, but does not notify again.
  writeFileSync(join(root, 'src', 'cart.ts'), 'export const a = 2\n')
  await agentDone(worker)
  await sleep(3200)
  await until(worker, finished)
  assert.equal(runCount(root), 2)
  assert.equal(host.callsOf('notifications.show').length, 1)
})

test('auto-run sees a second edit to a file that was already modified', async () => {
  const { worker, root } = await setupWorker({ git: true })
  writeFileSync(join(root, 'src', 'cart.ts'), 'export const a = 2\n')
  await agentDone(worker)
  await sleep(3200)
  await until(worker, finished)
  assert.equal(runCount(root), 1)

  // Same file, edited again: `git status` reads the same, the content does not.
  writeFileSync(join(root, 'src', 'cart.ts'), 'export const a = 3\n')
  await agentDone(worker)
  await sleep(3200)
  await until(worker, finished)
  assert.equal(runCount(root), 2)

  // Nothing changed this turn: no run.
  await agentDone(worker)
  await sleep(3500)
  assert.equal(runCount(root), 2)
})

test('does not run on its own when the setting is off', async () => {
  const { worker, root } = await setupWorker()
  await worker.request('tests.setAutoRun', { enabled: false })
  await agentDone(worker)
  await sleep(3500)
  const state = await worker.request('tests.state')
  assert.equal(state.lastRun, null)
  assert.equal(state.autoRun, false)
  assert.equal(runCount(root), 0)
})

test('says a remote workspace is not supported', async () => {
  const { worker } = await setupWorker()
  await focus(worker, 'w2')
  const state = await worker.request('tests.state')
  assert.deepEqual(state.support, { kind: 'remote' })
  await assert.rejects(worker.request('tests.run', { workspaceKey: workspaceKey('w2'), scope: 'all' }), /on this computer/)
})

test('fitRun keeps a run under the post size limit', () => {
  const message = '한글 메시지 '.repeat(500)
  const run: TestRun = {
    runner: 'vitest', scope: 'all', trigger: 'manual', startedAt: 0, finishedAt: 1,
    passed: 0, failed: 50, skipped: 0, total: 50, failuresTruncated: false, error: null,
    failures: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, file: 'a.ts', name: `t${i}`, title: `t${i}`, line: 1, message }))
  }
  const fitted = fitRun(run, 50_000)
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= 50_000)
  assert.ok((fitted?.failures.length ?? 0) >= 1)
  assert.equal(fitted?.failuresTruncated, true)
})
