// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { PanelState, TestRun } from './protocol'

const failedRun: TestRun = {
  runner: 'vitest',
  scope: 'all',
  trigger: 'agent-done',
  startedAt: 1_000,
  finishedAt: 3_500,
  passed: 4,
  failed: 2,
  skipped: 1,
  total: 7,
  failuresTruncated: false,
  error: null,
  failures: [
    { id: 'a', file: 'src/a.test.ts', name: 'a › works', title: 'works', line: 3, message: 'boom' },
    { id: 'b', file: 'src/b.test.ts', name: 'b › works', title: 'works', line: null, message: 'bang' }
  ]
}

const ready = (patch: Partial<PanelState> = {}): PanelState => ({
  workspaceKey: 'k1',
  workspace: { name: 'feature-x', branch: 'feature-x' },
  support: { kind: 'ok', runner: 'vitest' },
  running: null,
  lastRun: null,
  autoRun: true,
  ...patch
})

test('shows failures and sends one to the agent', async () => {
  const asked: unknown[] = []
  const host = mockHost({
    requests: {
      'tests.state': ready({ lastRun: failedRun }),
      'tests.askAgent': (input) => {
        asked.push(input)
        return { via: 'terminal', agent: 'Claude' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '2 failed' }))
  assert.ok(view.find({ text: '4 passed' }))
  assert.ok(view.find({ label: 'a › works' }))
  assert.ok(view.find({ label: 'b › works' }))

  // The first failure is open; its button sends that one failure.
  await view.press({ role: 'button', text: 'Ask agent to fix' })
  assert.deepEqual(asked, [{ workspaceKey: 'k1', failureId: 'a' }])
  assert.ok(view.find({ text: 'Sent to Claude.' }))

  await view.press({ role: 'button', text: 'Ask agent to fix all' })
  assert.deepEqual(asked.at(-1), { workspaceKey: 'k1' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('runs, follows the worker while it runs, and shows the result', async () => {
  const runs: unknown[] = []
  const host = mockHost({
    requests: {
      'tests.state': ready(),
      'tests.run': (input) => {
        runs.push(input)
        return ready({ running: { startedAt: Date.now(), scope: 'all', trigger: 'manual' } })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No runs yet' }))
  await view.press({ role: 'button', text: 'Run all' })
  assert.deepEqual(runs, [{ workspaceKey: 'k1', scope: 'all' }])
  assert.ok(view.find({ role: 'button', text: 'Stop' }))

  await view.post('tests.changed', ready({ lastRun: { ...failedRun, failed: 0, failures: [] } }))
  assert.ok(view.find({ label: 'All 4 tests passed' }))
  assert.equal(view.find({ role: 'button', text: 'Stop' }), null)
  assert.deepEqual(view.errors, [])
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
  for (const [support, title] of [
    [{ kind: 'no-workspace' }, 'No workspace'],
    [{ kind: 'remote' }, 'Remote workspace'],
    [{ kind: 'no-runner' }, 'No test runner found']
  ] as const) {
    const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ support }) } }) })
    assert.ok(view.find({ label: title }), title)
    await view.unmount()
  }
})

test('shows runner output when a run produced no report', async () => {
  const run = { ...failedRun, failures: [], failed: 0, passed: 0, total: 0, error: 'Error: bad config' }
  const view = await mount(panel, { host: mockHost({ requests: { 'tests.state': ready({ lastRun: run }) } }) })
  assert.ok(view.find({ label: 'vitest did not finish' }))
  await view.unmount()
})
