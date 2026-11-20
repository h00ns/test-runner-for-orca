// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose answers depend on a real workspace on disk. These scenarios also make the screenshots.
import { defineCheck } from 'orca/testing'
import type { PanelState, ProjectInfo, TestFailure, TestRun } from './protocol.ts'

const web: ProjectInfo = { id: 'apps/web:vitest', name: 'web', root: 'apps/web', runner: 'vitest', e2e: false }
const api: ProjectInfo = { id: 'apps/api:jest', name: 'api', root: 'apps/api', runner: 'jest', e2e: false }
const e2e: ProjectInfo = { id: 'apps/web:playwright', name: 'web', root: 'apps/web', runner: 'playwright', e2e: true }

const base: PanelState = {
  workspaceKey: 'k1',
  workspace: { name: 'checkout', branch: 'claude/coupon-rules' },
  support: { kind: 'ok', projects: [web] },
  configFile: false,
  running: null,
  lastRun: null,
  autoRun: true,
  autoFix: { enabled: false, round: 0, maxRounds: 3 }
}

const now = Date.UTC(2026, 10, 20, 12, 49)

const coupon: TestFailure = {
  id: 'apps/web:vitest|src/cart.test.ts::cart › applies the coupon once',
  project: web.id,
  file: 'apps/web/src/cart.test.ts',
  name: 'cart › applies the coupon once',
  title: 'applies the coupon once',
  line: 42,
  message: 'AssertionError: expected 8000 to be 9000\n\n- Expected\n+ Received\n\n- 9000\n+ 8000\n\n ❯ src/cart.test.ts:42:24',
  isNew: true,
  flaky: false
}
const price: TestFailure = {
  id: 'apps/api:jest|src/price.test.ts::',
  project: api.id,
  file: 'apps/api/src/price.test.ts',
  name: 'Test file failed to run',
  title: '',
  line: 1,
  message: "Cannot find module './format' from 'src/price.test.ts'",
  isNew: false,
  flaky: false
}
const clock: TestFailure = {
  id: 'apps/web:vitest|src/clock.test.ts::clock › ticks every second',
  project: web.id,
  file: 'apps/web/src/clock.test.ts',
  name: 'clock › ticks every second',
  title: 'ticks every second',
  line: 18,
  message: 'AssertionError: expected 999 to be 1000',
  isNew: false,
  flaky: true
}

const run: TestRun = {
  scope: 'related',
  trigger: 'agent-done',
  startedAt: now - 6200,
  finishedAt: now,
  changedFiles: 3,
  ran: 12,
  passed: 41,
  failed: 2,
  skipped: 1,
  flaky: 1,
  total: 45,
  projects: [
    { project: web.id, name: 'web', runner: 'vitest', passed: 33, failed: 1, skipped: 1, flaky: 1, error: null },
    { project: api.id, name: 'api', runner: 'jest', passed: 8, failed: 1, skipped: 0, flaky: 0, error: null }
  ],
  failures: [coupon, price, clock],
  failuresTruncated: false
}

const mono = { ...base, support: { kind: 'ok' as const, projects: [web, api, e2e] } }

export default defineCheck({
  'no runs yet': { requests: { 'tests.state': base } },
  running: {
    requests: {
      'tests.state': {
        ...mono,
        running: { startedAt: now - 5000, scope: 'related', trigger: 'agent-done', project: 'api', done: 1, total: 2 }
      }
    }
  },
  failing: { requests: { 'tests.state': { ...mono, lastRun: run, autoFix: { enabled: true, round: 1, maxRounds: 3 } } } },
  'single project failing': {
    requests: {
      'tests.state': {
        ...base,
        lastRun: { ...run, scope: 'all', changedFiles: null, ran: 45, failed: 1, flaky: 0, projects: [run.projects[0]!], failures: [coupon] }
      }
    }
  },
  passing: {
    requests: {
      'tests.state': {
        ...mono,
        lastRun: { ...run, trigger: 'manual', scope: 'all', changedFiles: null, ran: 42, failed: 0, flaky: 0, failures: [], projects: run.projects.map((p) => ({ ...p, failed: 0, flaky: 0 })) }
      }
    }
  },
  'runner error': {
    requests: {
      'tests.state': {
        ...base,
        lastRun: {
          ...run,
          failed: 0,
          flaky: 0,
          passed: 0,
          skipped: 0,
          total: 0,
          ran: 0,
          failures: [],
          projects: [{ ...run.projects[0]!, passed: 0, failed: 0, skipped: 0, flaky: 0, error: "Error: Cannot find module '@vitejs/plugin-react'\nRequire stack: vitest.config.ts" }]
        }
      }
    }
  },
  'config error': {
    requests: { 'tests.state': { ...base, configFile: true, support: { kind: 'config-error', message: 'projects[1].runner must be one of vitest, jest, playwright, cypress, gradle, maven, pytest.' } } }
  },
  remote: { requests: { 'tests.state': { ...base, support: { kind: 'remote' } } } },
  'no runner': { requests: { 'tests.state': { ...base, support: { kind: 'no-runner' } } } }
})
