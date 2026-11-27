// Runs src/worker.ts's activate(orca) over a mock host, against temporary workspaces whose
// "vitest" is a stub that writes a canned JSON report, so no real runner is needed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import type { PanelState, TestRun } from './protocol.ts'
import * as main from './worker.ts'
import { fitRun, markFlaky, mergeRun, unreachableTarget, workspaceKey, type ProjectOutcome } from './worker.ts'

const KEY = workspaceKey('w1')

// The stub records its argv (one line per run, in the folder it ran in), then behaves as the
// STUB_* variables say. A run given test files is a re-run: STUB_RETRY_PASS makes it pass.
const STUB_BIN = `
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const argv = process.argv.slice(2)
const out = argv.find((arg) => arg.startsWith('--outputFile='))?.slice('--outputFile='.length)
appendFileSync('runs.log', JSON.stringify(argv) + '\\n')
if (process.env.STUB_CRASH) { console.error('Error: failed to load vitest.config.ts'); process.exit(1) }
if (process.env.STUB_HANG_CHILD) {
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
}
const isRetry = argv[0] === 'run' && argv[1] && !argv[1].startsWith('--')
const finish = () => {
  const source = isRetry && process.env.STUB_RETRY_PASS ? 'pass.json' : existsSync('report.json') ? 'report.json' : 'pass.json'
  copyFileSync(source, out)
  if (process.env.STUB_UNHANDLED) { console.error('Vitest caught 1 unhandled error during the test run.'); process.exit(1) }
  // Like a real runner: 1 when a test failed, 0 when all passed.
  process.exit(JSON.parse(readFileSync(out, 'utf8')).testResults.some((r) => r.status === 'failed') ? 1 : 0)
}
setTimeout(finish, Number(process.env.STUB_DELAY_MS ?? 0))
`

const failing = (dir: string, extra = false) => ({
  testResults: [
    {
      name: join(dir, 'src/sum.test.ts'),
      status: 'failed',
      assertionResults: [
        { title: 'adds', ancestorTitles: ['sum'], status: 'passed', failureMessages: [] },
        {
          title: 'negatives',
          ancestorTitles: ['sum'],
          status: 'failed',
          failureMessages: [`AssertionError: expected 1 to be 2\n at ${join(dir, 'src/sum.test.ts')}:7:5`]
        },
        ...(extra ? [{ title: 'zero', ancestorTitles: ['sum'], status: 'failed', failureMessages: ['boom'] }] : [])
      ]
    }
  ]
})
const passing = (dir: string) => ({
  testResults: [{ name: join(dir, 'src/sum.test.ts'), status: 'passed', assertionResults: [{ title: 'adds', status: 'passed' }] }]
})

function write(root: string, file: string, content: unknown) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), typeof content === 'string' ? content : JSON.stringify(content))
}

/** A workspace: the stub vitest at the root, and each package's report. */
function makeWorkspace(packages: Record<string, unknown>, report: ((dir: string) => unknown) | null): string {
  const root = mkdtempSync(join(tmpdir(), 'test-runner-ws-'))
  write(root, 'node_modules/vitest/package.json', { name: 'vitest', bin: { vitest: 'stub.mjs' } })
  write(root, 'node_modules/vitest/stub.mjs', STUB_BIN)
  for (const [dir, pkg] of Object.entries(packages)) {
    write(root, join(dir, 'package.json'), pkg)
    write(root, join(dir, 'pass.json'), passing(join(root, dir)))
    if (report) {
      write(root, join(dir, 'report.json'), report(join(root, dir)))
    }
  }
  return root
}

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

function git(root: string, ...args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

async function setupWorker(
  options: {
    agents?: unknown[]
    report?: ((dir: string) => unknown) | null
    git?: boolean
    packages?: Record<string, unknown>
    settings?: Record<string, string | number | boolean>
  } = {}
) {
  const root = makeWorkspace(options.packages ?? { '.': { name: 'app', devDependencies: { vitest: '^3' } } }, options.report === undefined ? failing : options.report)
  if (options.git) {
    write(root, '.gitignore', 'node_modules\nruns.log\n')
    write(root, 'src/cart.ts', 'export const a = 1\n')
    git(root, 'init', '-q')
    git(root, 'add', '.')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  }
  const host = mockHost({
    settings: options.settings ?? {},
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'feature-x', path: root, branch: 'feature-x', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'remote', path: '/nowhere', branch: 'main', hostId: 'ssh:box' }
        ],
        truncated: false
      },
      'workspace.readContext': null,
      'agents.list': { agents: options.agents ?? [] },
      'terminal.sendText': { accepted: true },
      'terminal.focus': { focused: true },
      'agent.launch': { terminalId: 'new-term' },
      'editor.open': { opened: true },
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
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

function runs(dir: string): string[][] {
  try {
    return readFileSync(join(dir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
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
let runCounter = 0
/** Waits for the next finished run, not one that was already on screen. */
async function nextRun(worker: TestWorker, ms = 15_000): Promise<PanelState> {
  const before = [...worker.posts].reverse().find((p) => p.event === 'tests.changed' && (p.payload as PanelState).lastRun)
  const startedBefore = (before?.payload as PanelState | undefined)?.lastRun?.finishedAt ?? 0
  runCounter += 1
  return until(worker, (s) => s.running === null && (s.lastRun?.finishedAt ?? 0) > startedBefore, ms)
}

async function agentDone(worker: TestWorker, terminalId?: string) {
  await worker.emit('agent.status.changed', {
    workspaceId: 'raw-w1',
    workspaceListId: 'w1',
    paneKey: 'tab:pane',
    ...(terminalId ? { terminalId } : {}),
    state: 'done',
    receivedAt: Date.now()
  })
}

test('detects vitest and runs it with a JSON report', async () => {
  const { root, worker } = await setupWorker()
  const before = await worker.request('tests.state', {})
  assert.deepEqual(before.support, { kind: 'ok', projects: [{ id: '.:vitest', name: 'app', root: '', runner: 'vitest', e2e: false }] })
  assert.equal(before.workspaceKey, KEY)

  const started = await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  assert.equal(started.running?.scope, 'all')
  const state = await until(worker, finished)
  assert.equal(state.lastRun?.passed, 1)
  assert.equal(state.lastRun?.failed, 1)
  assert.deepEqual(state.lastRun?.projects.map((p) => [p.project, p.error]), [['.:vitest', null]])
  assert.deepEqual(state.lastRun?.failures.map((f) => [f.project, f.file, f.name, f.line, f.isNew, f.flaky]), [
    ['.:vitest', 'src/sum.test.ts', 'sum › negatives', 7, false, false]
  ])
  // The run, then the retry of the failing file (still failing: not flaky).
  assert.deepEqual(runs(root).map((argv) => argv.slice(0, 2)), [['run', '--reporter=json'], ['run', 'src/sum.test.ts']])
  assert.deepEqual(worker.refusals, [])
})

test('a failure that passes on a re-run is flaky, not failed', async () => {
  env('STUB_RETRY_PASS', '1')
  const { worker } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.equal(state.lastRun?.failed, 0)
  assert.equal(state.lastRun?.flaky, 1)
  assert.equal(state.lastRun?.failures[0]?.flaky, true)
})

test('retrying can be turned off', async () => {
  const { root, worker } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  assert.equal(runs(root).length, 1)
})

test('a failure missing from the run before is new', async () => {
  const { root, worker } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await nextRun(worker)
  write(root, 'report.json', failing(root, true))
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await nextRun(worker)
  assert.deepEqual(state.lastRun?.failures.map((f) => [f.name, f.isNew]), [
    ['sum › negatives', false],
    ['sum › zero', true]
  ])
})

test('re-runs only the files that failed', async () => {
  const { root, worker } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'failed' })
  await until(worker, (s) => s.running === null && s.lastRun?.scope === 'failed')
  assert.deepEqual(runs(root).at(-1)?.slice(0, 2), ['run', 'src/sum.test.ts'])
})

test('a monorepo runs each package, and one package on request', async () => {
  const { root, worker } = await setupWorker({
    settings: { retryFailures: false },
    packages: {
      '.': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { vitest: '^3' } },
      'packages/a': { name: '@m/a', devDependencies: { vitest: '^3' } },
      'packages/b': { name: '@m/b', devDependencies: { vitest: '^3' } }
    },
    report: (dir) => (dir.endsWith('packages/a') ? failing(dir) : passing(dir))
  })
  const state0 = await worker.request('tests.state', {})
  assert.deepEqual(state0.support.kind === 'ok' && state0.support.projects.map((p) => p.id), ['packages/a:vitest', 'packages/b:vitest'])
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.deepEqual(state.lastRun?.projects.map((p) => [p.name, p.passed, p.failed]), [
    ['@m/a', 1, 1],
    ['@m/b', 1, 0]
  ])
  assert.deepEqual(state.lastRun?.failures.map((f) => f.file), ['packages/a/src/sum.test.ts'])
  assert.equal(runs(join(root, 'packages/a')).length, 1)
  assert.equal(runs(root).length, 0, 'the root only hoists vitest: it runs nothing itself')

  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all', project: 'packages/b:vitest' })
  const only = await nextRun(worker)
  // Only @m/b ran again; @m/a keeps its earlier result and failure.
  assert.equal(runs(join(root, 'packages/b')).length, 2)
  assert.equal(runs(join(root, 'packages/a')).length, 1)
  assert.deepEqual(only.lastRun?.projects.map((p) => [p.name, p.failed]), [['@m/a', 1], ['@m/b', 0]])
  assert.equal(only.lastRun?.ran, 1)
})

test('shows what the runner printed when it writes no report', async () => {
  env('STUB_CRASH', '1')
  const { worker } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.match(state.lastRun?.projects[0]?.error ?? '', /failed to load vitest\.config\.ts/)
})

test('a non-zero exit with no failing test is an error, not a pass', async () => {
  env('STUB_UNHANDLED', '1')
  const { worker } = await setupWorker({ report: passing })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.match(state.lastRun?.projects[0]?.error ?? '', /exited with code 1 although no test failed[\s\S]*unhandled error/)
})

test('finishes even when something the runner started keeps its output open', async () => {
  env('STUB_HANG_CHILD', '1')
  const { worker } = await setupWorker({ settings: { retryFailures: false } })
  const started = Date.now()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished, 10_000)
  assert.equal(state.lastRun?.failed, 1)
  assert.ok(Date.now() - started < 8000, 'did not wait for the lingering process')
})

test('a second run request while one is starting is refused, not run twice', async () => {
  env('STUB_DELAY_MS', '500')
  const { root, worker } = await setupWorker({ settings: { retryFailures: false } })
  const results = await Promise.allSettled([
    worker.request('tests.run', { workspaceKey: KEY, scope: 'all' }),
    worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  await until(worker, finished)
  assert.equal(runs(root).length, 1)
})

test('Stop cancels the run and the re-run queued behind it', async () => {
  env('STUB_DELAY_MS', '9000')
  const { root, worker } = await setupWorker({ git: true })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await sleep(300)
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  await sleep(3300)
  await worker.request('tests.cancel', { workspaceKey: KEY })
  await until(worker, (s) => s.running === null, 10_000)
  await sleep(3500)
  const state = await worker.request('tests.state', {})
  assert.equal(state.running, null)
  assert.equal(state.lastRun, null, 'a cancelled run leaves no result')
  assert.equal(runs(root).length, 1)
})

test('after an agent finishes, only tests related to the changed files run', async () => {
  const { root, worker } = await setupWorker({ git: true, settings: { retryFailures: false } })
  // No earlier run to diff against: the first automatic run covers everything.
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  const first = await nextRun(worker)
  assert.equal(first.lastRun?.scope, 'all')
  write(root, 'src/cart.ts', 'export const a = 3\n')
  await agentDone(worker)
  const state = await nextRun(worker)
  assert.equal(state.lastRun?.scope, 'related')
  assert.equal(state.lastRun?.trigger, 'agent-done')
  assert.equal(state.lastRun?.changedFiles, 1)
  assert.deepEqual(runs(root).at(-1)?.slice(0, 3), ['related', '--run', join(root, 'src/cart.ts')])

  // Commit the change: the next turn diffs against the commit the last run saw.
  git(root, 'add', '.')
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'agent')
  write(root, 'src/other.ts', 'export const b = 1\n')
  await agentDone(worker)
  await nextRun(worker)
  const last = runs(root).at(-1)!
  assert.ok(last.includes(join(root, 'src/cart.ts')) && last.includes(join(root, 'src/other.ts')), JSON.stringify(last))
})

test('"all" scope after an agent finishes runs everything', async () => {
  const { root, worker } = await setupWorker({ git: true, settings: { retryFailures: false, autoRunScope: 'all' } })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  const state = await nextRun(worker)
  assert.equal(state.lastRun?.scope, 'all')
  assert.equal(runs(root)[0]?.[0], 'run')
})

test('runs on its own after an agent turn that changed code, notifies once, skips turns that changed nothing', async () => {
  const { worker, host, root } = await setupWorker({ git: true, settings: { retryFailures: false } })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  await nextRun(worker)
  const [note] = host.callsOf('notifications.show') as { title: string }[]
  assert.equal(note?.title, '1 failing test in feature-x')

  // Same file edited again: `git status` reads the same, the content does not. Same failure: no new note.
  write(root, 'src/cart.ts', 'export const a = 3\n')
  await agentDone(worker)
  await nextRun(worker)
  assert.equal(runs(root).length, 2)
  assert.equal(host.callsOf('notifications.show').length, 1)

  // Nothing changed this turn: no run.
  await agentDone(worker)
  await sleep(3500)
  assert.equal(runs(root).length, 2)
})

test('does not run on its own when the setting is off', async () => {
  const { worker, root } = await setupWorker({ git: true, settings: { autoRunWhenAgentFinishes: false } })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  await sleep(3500)
  const state = await worker.request('tests.state', {})
  assert.equal(state.lastRun, null)
  assert.equal(state.autoRun, false)
  assert.equal(runs(root).length, 0)
})

test('auto-fix sends the failures an agent caused back to it, then stops after the last round', async () => {
  const { worker, host, root } = await setupWorker({
    git: true,
    settings: { retryFailures: false, autoFix: true, autoFixMaxRounds: 2 },
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  for (const round of [1, 2, 3]) {
    write(root, 'src/cart.ts', `export const a = ${round + 1}\n`)
    await agentDone(worker, 't1')
    await nextRun(worker)
  }
  const sent = host.callsOf('terminal.sendText') as { terminalId: string; text: string }[]
  assert.equal(sent.length, 2)
  assert.match(sent[0]!.text, /^\(Test Runner, automatic round 1 of 2\) The test "sum › negatives"/)
  assert.match(sent[1]!.text, /^\(Test Runner, automatic round 2 of 2\)/)
  const titles = (host.callsOf('notifications.show') as { title: string }[]).map((n) => n.title)
  assert.ok(titles.includes('Sent 1 new failure back to Claude Code (round 1 of 2)'), titles.join(' | '))
  assert.ok(titles.includes('Stopped sending failures in feature-x after 2 rounds'), titles.join(' | '))
  assert.equal(host.callsOf('agent.launch').length, 0, 'an automatic loop never starts an agent')
})

test('auto-fix leaves failures that were there before the agent alone', async () => {
  const { worker, host, root } = await setupWorker({
    git: true,
    settings: { retryFailures: false },
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await nextRun(worker)
  await worker.request('tests.setAutoFix', { enabled: true })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker, 't1')
  await nextRun(worker)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

test('sends a failure to the idle agent in the workspace', async () => {
  const { worker, host } = await setupWorker({
    settings: { retryFailures: false },
    agents: [
      { terminalId: 'busy', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 0 },
      { terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }
    ]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  const failureId = state.lastRun?.failures[0]?.id ?? ''

  const answer = await worker.request('tests.askAgent', { workspaceKey: KEY, failureId })
  assert.deepEqual(answer, { via: 'terminal', agent: 'Claude Code', sent: 1 })
  const [sent] = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
  assert.equal(sent?.terminalId, 't1')
  assert.match(sent?.text ?? '', /"sum › negatives" in src\/sum\.test\.ts:7/)
  assert.ok(!(sent?.text ?? '').includes('\n'))
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: KEY, onlyNew: true }), /no new failures to send/)
})

test('acts on the workspace the panel showed, even after focus moves', async () => {
  const { worker, host } = await setupWorker({
    settings: { retryFailures: false },
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  await focus(worker, 'w2')
  await worker.request('tests.askAgent', { workspaceKey: KEY })
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: 'w1' }])
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: 'gone' }), /no longer open/)
})

test('starts an agent when the workspace has none, waits until it is ready, then types the failure', async () => {
  const { worker, host } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  // Orca lists a started agent a moment later; until then the terminal is not there.
  let listed = 0
  host.respond('agents.list', () =>
    host.callsOf('agent.launch').length > 0 && ++listed > 2
      ? { agents: [{ terminalId: 'new-term', title: 'Untitled', agent: 'claude', state: 'done', stateStartedAt: 0 }] }
      : { agents: [] }
  )
  assert.deepEqual(await worker.request('tests.askAgent', { workspaceKey: KEY }), { via: 'launch', agent: 'Claude Code', sent: 1 })
  const [launch] = host.callsOf('agent.launch') as { agent: string; prompt?: string }[]
  assert.equal(launch?.agent, 'claude')
  assert.equal(launch?.prompt, undefined, "not agent.launch's own prompt: Orca can drop it")
  const [sent] = host.callsOf('terminal.sendText') as { terminalId: string; text: string }[]
  assert.equal(sent?.terminalId, 'new-term')
  assert.match(sent?.text ?? '', /negatives/)
})

test('a busy agent is never typed into', async () => {
  const { worker, host } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  host.respond('agents.list', {
    agents: [{ terminalId: 't9', title: 'Claude', agent: 'claude', state: 'blocked', stateStartedAt: 0 }]
  })
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: KEY }), /busy/)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

test('failures that could not reach a server are marked and never sent to an agent', async () => {
  const unreachable = (dir: string) => ({
    testResults: [
      {
        name: join(dir, 'src/api.test.ts'),
        status: 'failed',
        assertionResults: [
          { title: 'health', status: 'failed', failureMessages: ['Error: connect ECONNREFUSED 127.0.0.1:59999'] }
        ]
      }
    ]
  })
  const { worker, host } = await setupWorker({
    report: unreachable,
    settings: { retryFailures: false },
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  assert.equal(state.lastRun?.failures[0]?.unreachable, '127.0.0.1:59999')
  await assert.rejects(worker.request('tests.askAgent', { workspaceKey: KEY }), /running server/)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

test('opens the failing file in the editor', async () => {
  const { worker, host } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  const state = await until(worker, finished)
  await worker.request('tests.openFile', { workspaceKey: KEY, failureId: state.lastRun?.failures[0]?.id ?? '' })
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'w1', path: 'src/sum.test.ts' }])
})

test('the status bar follows the focused workspace', async () => {
  const { worker, host } = await setupWorker({ settings: { retryFailures: false } })
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await until(worker, finished)
  await sleep(50)
  const items = host.callsOf('statusBar.update') as { text?: string; tone?: string; visible?: boolean }[]
  assert.ok(items.some((i) => i.text === 'Testing…' && i.tone === 'accent'), JSON.stringify(items))
  assert.deepEqual(items.at(-1), {
    id: 'tests',
    visible: true,
    text: '1 failed',
    icon: 'error',
    tone: 'danger',
    tooltip: 'Test Runner: run tests in this workspace'
  })
  await focus(worker, 'w2')
  await sleep(50)
  assert.deepEqual((host.callsOf('statusBar.update') as unknown[]).at(-1), { id: 'tests', visible: false })
})

test('notifications follow the language the panel reports', async () => {
  const { worker, host, root } = await setupWorker({ git: true, settings: { retryFailures: false } })
  await worker.request('tests.state', { locale: 'ko' })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  await nextRun(worker)
  const [note] = host.callsOf('notifications.show') as { title: string }[]
  assert.equal(note?.title, 'feature-x: 테스트 1개 실패')
})

test('says a remote workspace is not supported', async () => {
  const { worker } = await setupWorker()
  await focus(worker, 'w2')
  const state = await worker.request('tests.state', {})
  assert.deepEqual(state.support, { kind: 'remote' })
  await assert.rejects(worker.request('tests.run', { workspaceKey: workspaceKey('w2'), scope: 'all' }), /on this computer/)
})

test('fitRun keeps a run under the post size limit; markFlaky flags what did not fail again', () => {
  const message = '한글 메시지 '.repeat(500)
  const run: TestRun = {
    scope: 'all', trigger: 'manual', startedAt: 0, finishedAt: 1, changedFiles: null, ran: 50,
    passed: 0, failed: 50, skipped: 0, flaky: 0, total: 50, failuresTruncated: false,
    projects: [{ project: 'p', name: 'p', runner: 'vitest', passed: 0, failed: 50, skipped: 0, flaky: 0, error: null }],
    failures: Array.from({ length: 50 }, (_, i) => ({ id: `f${i}`, project: 'p', file: 'a.ts', name: `t${i}`, title: `t${i}`, line: 1, message, isNew: false, flaky: false }))
  }
  const fitted = fitRun(run, 50_000)
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= 50_000)
  assert.equal(fitted?.failuresTruncated, true)
  assert.deepEqual(markFlaky(run.failures.slice(0, 2), new Set(['f0'])).map((f) => f.flaky), [false, true])
})

test('Stop during the flaky re-run stops the run: nothing saved, nothing sent', async () => {
  env('STUB_DELAY_MS', '2500')
  const { worker, host } = await setupWorker()
  await worker.request('tests.run', { workspaceKey: KEY, scope: 'all' })
  await sleep(3200) // the first run is done; the re-run of the failing file is under way
  await worker.request('tests.cancel', { workspaceKey: KEY })
  await until(worker, (s) => s.running === null, 10_000)
  const state = await worker.request('tests.state', {})
  assert.equal(state.lastRun, null)
  assert.equal(host.callsOf('notifications.show').length, 0)
})

test('auto-fix never types into an agent that is busy again, or into another agent', async () => {
  const { worker, host, root } = await setupWorker({
    git: true,
    settings: { retryFailures: false, autoFix: true },
    agents: [
      { terminalId: 't1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: 0 },
      { terminalId: 't2', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 0 }
    ]
  })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker, 't1')
  await nextRun(worker)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

test('auto-fix skips a turn the person interrupted', async () => {
  const { worker, host, root } = await setupWorker({
    git: true,
    settings: { retryFailures: false, autoFix: true },
    agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }]
  })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await worker.emit('agent.status.changed', {
    workspaceId: 'raw-w1',
    workspaceListId: 'w1',
    paneKey: 'tab:pane',
    terminalId: 't1',
    state: 'done',
    receivedAt: Date.now(),
    mainAgent: { state: 'done', outcome: 'interruption', stateStartedAt: 0 }
  })
  const state = await nextRun(worker)
  assert.equal(state.lastRun?.failed, 1, 'the tests still run')
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

test('a deleted file makes the next related run cover the whole project', async () => {
  const { worker, root } = await setupWorker({ git: true, settings: { retryFailures: false } })
  write(root, 'src/cart.ts', 'export const a = 2\n')
  await agentDone(worker)
  await nextRun(worker) // first automatic run: everything
  rmSync(join(root, 'src/cart.ts'))
  await agentDone(worker)
  const state = await nextRun(worker)
  assert.equal(runs(root).at(-1)?.[0], 'run', 'not `related`: the deleted file cannot pick its importers')
  assert.equal(state.lastRun?.scope, 'related')
})

test('results of workspaces Orca no longer lists are pruned from storage', async () => {
  const root = makeWorkspace({ '.': { name: 'app', devDependencies: { vitest: '^3' } } }, failing)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const stale = `ws:${workspaceKey('gone-worktree')}`
  const host = mockHost({
    storage: { [stale]: { run: null, signature: null, head: null }, locale: 'en' },
    results: {
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'x', path: root, branch: 'x', hostId: 'local' }], truncated: false },
      'workspace.readContext': null,
      'statusBar.update': { ok: true }
    }
  })
  const worker = await mountWorker(main, { host })
  cleanup.push(() => worker.deactivate())
  await sleep(300)
  assert.deepEqual(Object.keys(host.data().storage).sort(), ['locale'])
})

test('mergeRun: a partial run replaces the files it reached, by their counts; the rest keep theirs', () => {
  const f = (project: string, file: string, name: string, flaky = false) => ({
    id: `${project}|${file}::${name}`, project, file, name, title: name, line: null, message: 'x', isNew: false, flaky
  })
  const previous: TestRun = {
    scope: 'all', trigger: 'manual', startedAt: 0, finishedAt: 1, changedFiles: null, ran: 30,
    passed: 25, failed: 3, skipped: 2, flaky: 0, total: 30, failuresTruncated: false,
    projects: [
      { project: 'a', name: 'a', runner: 'vitest', passed: 10, failed: 2, skipped: 2, flaky: 0, error: null,
        files: { 'a/x.test.ts': [4, 1, 0], 'a/y.test.ts': [6, 1, 2] } },
      { project: 'b', name: 'b', runner: 'jest', passed: 15, failed: 1, skipped: 0, flaky: 0, error: null,
        files: { 'b/z.test.ts': [15, 1, 0] } }
    ],
    failures: [f('a', 'a/x.test.ts', 'x'), f('a', 'a/y.test.ts', 'y'), f('b', 'b/z.test.ts', 'z')]
  }
  // A related run reached a/x.test.ts (now all 5 pass) and a new a/w.test.ts (1 of 2 fails).
  const outcome: ProjectOutcome = {
    project: { id: 'a', name: 'a', runner: 'vitest' },
    ranFiles: ['a/x.test.ts', 'a/w.test.ts'],
    result: { project: 'a', name: 'a', runner: 'vitest', passed: 6, failed: 1, skipped: 0, flaky: 0, error: null,
      files: { 'a/x.test.ts': [5, 0, 0], 'a/w.test.ts': [1, 1, 0] } },
    failures: [{ ...f('a', 'a/w.test.ts', 'w'), isNew: true }],
    truncated: false,
    ran: 7
  }
  const meta = { scope: 'related' as const, trigger: 'agent-done' as const, startedAt: 2, finishedAt: 3, changedFiles: 1 }
  const merged = mergeRun(previous, [outcome], ['a', 'b'], meta)
  assert.deepEqual(merged.failures.map((x) => [x.file, x.isNew]), [['a/y.test.ts', false], ['a/w.test.ts', true], ['b/z.test.ts', false]])
  // a: x 5/0/0 + y 6/1/2 + w 1/1/0 = 12 passed, 2 failed, 2 skipped. b unchanged.
  assert.deepEqual(merged.projects.map((p) => [p.project, p.passed, p.failed, p.skipped]), [['a', 12, 2, 2], ['b', 15, 1, 0]])
  assert.deepEqual([merged.passed, merged.failed, merged.skipped, merged.total, merged.ran], [27, 3, 2, 32, 7])

  // Running the same partial run again changes nothing: counts never drift.
  const again = mergeRun(merged, [outcome], ['a', 'b'], meta)
  assert.deepEqual([again.passed, again.failed, again.skipped, again.total], [27, 3, 2, 32])

  // A whole-project run replaces it; an error keeps the last known failures under the error.
  const whole = mergeRun(previous, [{ ...outcome, ranFiles: null, failures: [], result: { ...outcome.result, failed: 0, passed: 14, files: undefined } }], ['a', 'b'], { ...meta, scope: 'all' })
  assert.deepEqual(whole.failures.map((x) => x.file), ['b/z.test.ts'])
  const broken = mergeRun(previous, [{ ...outcome, failures: [], result: { ...outcome.result, error: 'boom' } }], ['a', 'b'], { ...meta, scope: 'all' })
  assert.equal(broken.projects[0]?.error, 'boom')
  assert.equal(broken.failures.length, 3)
  // A project that no longer exists is dropped.
  assert.deepEqual(mergeRun(previous, [], ['b'], meta).projects.map((p) => p.project), ['b'])
})

test('unreachableTarget names the address a test could not connect to', () => {
  assert.equal(unreachableTarget('Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/create'), 'http://localhost:3000')
  assert.equal(unreachableTarget('Error: connect ECONNREFUSED 127.0.0.1:5432'), '127.0.0.1:5432')
  assert.equal(unreachableTarget('TypeError: fetch failed ... ECONNREFUSED'), 'the server')
  assert.equal(unreachableTarget('AssertionError: expected 1 to be 2'), null)
})

test('markFlaky compares by test, not by the #n a repeated name gets', () => {
  const g = (id: string) => ({ id, project: 'p', file: 'a', name: 'n', title: 'n', line: null, message: '', isNew: false, flaky: false })
  assert.deepEqual(markFlaky([g('p|a::t'), g('p|a::t#2'), g('p|a::u')], new Set(['p|a::t'])).map((x) => x.flaky), [false, false, true])
})

