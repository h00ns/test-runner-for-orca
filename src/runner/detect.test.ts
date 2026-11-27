import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolveNode, runnerEnv } from './detect.ts'
import type { ProjectSpec } from './projects.ts'
import { invocation } from './run.ts'

const bin = mkdtempSync(join(tmpdir(), 'detect-test-'))
after(() => rmSync(bin, { recursive: true, force: true }))
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
writeFileSync(join(bin, nodeName), '')
chmodSync(join(bin, nodeName), 0o755)
const ORCA = '/Applications/Orca.app/Contents/MacOS/Orca'

// Orca starts every plugin worker with ELECTRON_RUN_AS_NODE=1 and its own Electron as execPath.
const workerEnv = { PATH: bin, HOME: '/home/me', ELECTRON_RUN_AS_NODE: '1' }

test("the user's node runs the tests, not Orca's Electron, inside a plugin worker", () => {
  const node = resolveNode(workerEnv, ORCA)
  assert.equal(node.program, join(bin, nodeName))
  assert.equal(node.env.ELECTRON_RUN_AS_NODE, undefined, 'a child must not inherit it')
  assert.ok(node.env.PATH?.startsWith(bin))
})

test('runner environment: colours off; no CI (Playwright configs read it), no ELECTRON_RUN_AS_NODE', () => {
  const { program, env } = runnerEnv({ ...workerEnv, CI: undefined }, ORCA)
  assert.equal(program, join(bin, nodeName))
  assert.deepEqual([env.CI, env.FORCE_COLOR, env.NO_COLOR, env.ELECTRON_RUN_AS_NODE], [undefined, '0', '1', undefined])
})

test('a JS runner starts with that node', () => {
  const project: ProjectSpec = {
    id: '.:vitest', name: 'app', root: '', runner: 'vitest', e2e: false, cwd: '/w', entry: '/w/node_modules/vitest/vitest.mjs',
    args: [], env: { TZ: 'UTC' }, autoRun: true
  }
  const call = invocation(project, { scope: 'all' }, '/tmp/out', workerEnv, ORCA)
  assert.equal(call.program, join(bin, nodeName))
  assert.equal(call.args[0], '/w/node_modules/vitest/vitest.mjs')
  assert.ok(call.args.includes('--coverage.enabled=false'))
  assert.equal(call.env.TZ, 'UTC')
  assert.equal(call.env.ELECTRON_RUN_AS_NODE, undefined)
})
