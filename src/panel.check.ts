// `orca plugin check` renders the panel once per scenario. `requests` stands in for the worker,
// whose answers depend on a real workspace on disk.
import { defineCheck } from 'orca/testing'
import type { PanelState } from './protocol'

const base: PanelState = {
  workspaceKey: 'k1',
  workspace: { name: 'checkout', branch: 'claude/coupon-rules' },
  support: { kind: 'ok', runner: 'vitest' },
  running: null,
  lastRun: null,
  autoRun: true
}

const failing: PanelState = {
  ...base,
  lastRun: {
    runner: 'vitest',
    scope: 'all',
    trigger: 'agent-done',
    startedAt: Date.now() - 64_000,
    finishedAt: Date.now() - 60_000,
    passed: 41,
    failed: 2,
    skipped: 1,
    total: 44,
    failuresTruncated: false,
    error: null,
    failures: [
      {
        id: 'src/cart.test.ts::cart › applies the coupon once',
        file: 'src/cart.test.ts',
        name: 'cart › applies the coupon once',
        title: 'applies the coupon once',
        line: 42,
        message:
          'AssertionError: expected 8000 to be 9000\n\n- Expected\n+ Received\n\n- 9000\n+ 8000\n\n ❯ src/cart.test.ts:42:24'
      },
      {
        id: 'src/price.test.ts::',
        file: 'src/price.test.ts',
        name: 'Test file failed to run',
        title: '',
        line: 1,
        message: "Error: Failed to resolve import './format' from 'src/price.test.ts'. Does the file exist?"
      }
    ]
  }
}

export default defineCheck({
  'no runs yet': { requests: { 'tests.state': base } },
  running: {
    requests: {
      'tests.state': { ...base, running: { startedAt: Date.now() - 5000, scope: 'all', trigger: 'manual' } }
    }
  },
  failing: { requests: { 'tests.state': failing } },
  passing: {
    requests: {
      'tests.state': {
        ...failing,
        lastRun: { ...failing.lastRun!, failed: 0, failures: [], trigger: 'manual' }
      }
    }
  },
  'runner error': {
    requests: {
      'tests.state': {
        ...base,
        lastRun: {
          ...failing.lastRun!,
          failures: [],
          error: 'Error: Cannot find module \'@vitejs/plugin-react\'\nRequire stack: vitest.config.ts'
        }
      }
    }
  },
  remote: { requests: { 'tests.state': { ...base, support: { kind: 'remote' } } } },
  'no runner': { requests: { 'tests.state': { ...base, support: { kind: 'no-runner' } } } }
})
