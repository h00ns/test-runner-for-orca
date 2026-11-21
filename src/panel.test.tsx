// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { PanelState, ProjectInfo, TestFailure, TestRun } from './protocol.ts'

const web: ProjectInfo = { id: 'web', name: 'web', root: 'apps/web', runner: 'vitest', e2e: false }
const api: ProjectInfo = { id: 'api', name: 'api', root: 'apps/api', runner: 'jest', e2e: false }

const failure = (id: string, extra: Partial<TestFailure> = {}): TestFailure => ({
  id,
  project: 'web',
  file: `apps/web/src/${id}.test.ts`,
  name: `${id} › works`,
  title: 'works',
  line: 3,
  message: 'boom',
  isNew: false,
  flaky: false,
  ...extra
})

const failedRun: TestRun = {
  scope: 'all',
  trigger: 'agent-done',
  startedAt: 1_000,
  finishedAt: 3_500,
  changedFiles: null,
  ran: 8,
  passed: 4,
  failed: 2,
  skipped: 1,
  flaky: 1,
  total: 8,
  projects: [
    { project: 'web', name: 'web', runner: 'vitest', passed: 3, failed: 1, skipped: 1, flaky: 1, error: null },
    { project: 'api', name: 'api', runner: 'jest', passed: 1, failed: 1, skipped: 0, flaky: 0, error: null }
  ],
  failures: [failure('a', { isNew: true }), failure('b', { project: 'api' }), failure('c', { flaky: true })],
  failuresTruncated: false
}

const ready = (patch: Partial<PanelState> = {}): PanelState => ({
  workspaceKey: 'k1',
  workspace: { name: 'feature-x', branch: 'feature-x' },
  support: { kind: 'ok', projects: [web, api] },
  configFile: false,
  running: null,
  lastRun: null,
  autoRun: true,
  autoFix: { enabled: false, round: 0, maxRounds: 3 },
  ...patch
})

test('shows failures with their project, badges and actions', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    requests: {
      'tests.state': ready({ lastRun: failedRun }),
      'tests.askAgent': (input) => {
        asked.push(input)
        return { via: 'terminal', agent: 'Claude', sent: 1 }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '2 failed' }))
  assert.ok(view.find({ text: '1 new' }))
  assert.ok(view.find({ text: '1 flaky' }))
  assert.ok(view.find({ type: 'Table' }), 'two projects ran: a table of them')
  assert.ok(view.find({ label: 'a › works' }))
  assert.ok(view.find({ label: 'b › works' }))

  await view.press({ role: 'button', text: 'Ask agent to fix' })
  assert.deepEqual(asked, [{ workspaceKey: 'k1', failureId: 'a' }])
  assert.ok(view.find({ text: 'Sent 1 failure to Claude.' }))

  await view.press({ role: 'button', text: 'Fix new only' })
  assert.deepEqual(asked.at(-1), { workspaceKey: 'k1', onlyNew: true })
  await view.press({ role: 'button', text: 'Ask agent to fix all' })
  assert.deepEqual(asked.at(-1), { workspaceKey: 'k1' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('runs the chosen project, follows the worker while it runs, and shows the result', async () => {
  const runs: unknown[] = []
  const host = mockHost({
    requests: {
      'tests.state': ready(),
      'tests.run': (input) => {
        // Orca checks request input with z.json(): an `undefined` value is refused.
        assert.deepEqual(JSON.parse(JSON.stringify(input)), input, 'request input must be plain JSON')
        assert.ok(!Object.values(input).includes(undefined), JSON.stringify(Object.keys(input)))
        runs.push(input)
        return ready({ running: { startedAt: Date.now(), scope: 'all', trigger: 'manual', project: 'api', done: 0, total: 1 } })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No runs yet' }))
  await view.press({ role: 'button', text: 'Run all' })
  assert.deepEqual(runs, [{ workspaceKey: 'k1', scope: 'all' }], 'All projects: no project key at all')
  await view.post('tests.changed', ready())
  await view.select({ type: 'Select' }, 'api')
  await view.press({ role: 'button', text: 'Run all' })
  assert.deepEqual(runs.at(-1), { workspaceKey: 'k1', scope: 'all', project: 'api' })
  assert.ok(view.find({ role: 'button', text: 'Stop' }))
  assert.ok(view.find({ text: 'api' }))

  const passed = { ...failedRun, failed: 0, flaky: 0, failures: [], projects: [{ ...failedRun.projects[1]!, failed: 0 }] }
  await view.post('tests.changed', ready({ lastRun: passed }))
  assert.ok(view.find({ label: 'All 4 tests passed' }))
  assert.equal(view.find({ role: 'button', text: 'Stop' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('turns auto-fix on and shows its round', async () => {
  const host = mockHost({
    requests: {
      'tests.state': ready(),
      'tests.setAutoFix': ({ enabled }) => ready({ autoFix: { enabled, round: 2, maxRounds: 3 } })
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ label: 'Send new failures back to the agent' })
  assert.ok(view.find({ text: 'Round 2 of 3 in this loop' }))
  await view.unmount()
})

test('shows why a request failed', async () => {
  const host = mockHost({
    requests: {
      'tests.state': ready({ lastRun: failedRun }),
      'tests.askAgent': () => {
        throw hostError('conflict', 'The agent in this workspace is busy. Try again when it finishes.')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ role: 'button', text: 'Ask agent to fix all' })
  assert.ok(view.find({ text: /busy/ }))
  await view.unmount()
})

test('explains workspaces it cannot run', async () => {
  for (const [support, query] of [
    [{ kind: 'no-workspace' }, { label: 'No workspace' }],
    [{ kind: 'remote' }, { label: 'Remote workspace' }],
    [{ kind: 'no-runner' }, { label: 'No test runner found' }],
    [{ kind: 'config-error', message: 'Unknown key "x".' }, { text: 'Unknown key "x".' }]
  ] as const) {
    const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ support }) } }) })
    assert.ok(view.find(query), JSON.stringify(query))
    await view.unmount()
  }
})

test('shows runner output for a project that produced no report', async () => {
  const run = {
    ...failedRun,
    failures: [],
    failed: 0,
    flaky: 0,
    passed: 0,
    skipped: 0,
    total: 0,
    ran: 0,
    projects: [{ ...failedRun.projects[0]!, error: 'Error: bad config' }]
  }
  const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ lastRun: run }) } }) })
  assert.ok(view.find({ label: 'web: vitest did not finish' }))
  await view.unmount()
})

test('a related run that picked no test says so', async () => {
  const run = { ...failedRun, scope: 'related' as const, changedFiles: 2, ran: 0, failures: [], failed: 0, flaky: 0, passed: 0, skipped: 0, total: 0, projects: [] }
  const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ lastRun: run }) } }) })
  assert.ok(view.find({ label: 'No tests ran' }))
  await view.unmount()
})

test('a partial run says how many tests it ran', async () => {
  const run = { ...failedRun, scope: 'related' as const, changedFiles: 1, ran: 3 }
  const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ lastRun: run }) } }) })
  assert.ok(view.find({ text: '3 tests ran; earlier results kept for the rest' }))
  await view.unmount()
})
