import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PROMPT_CHARS, promptForFailure, promptForFailures, reproduceCommand, type PromptProject } from './agent-prompt.ts'
import type { TestFailure } from './protocol.ts'

const vitest: PromptProject = { id: '.:vitest', root: '', runner: 'vitest' }
const failure: TestFailure = {
  id: '.:vitest|src/sum.test.ts::sum › negatives',
  project: '.:vitest',
  file: 'src/sum.test.ts',
  name: 'sum › negatives',
  title: 'negatives',
  line: 14,
  message: 'AssertionError: expected 1 to be 2\n\n- Expected\n+ Received',
  isNew: true,
  flaky: false
}

test('one failure becomes one line naming the test, error and a reproduce command', () => {
  const prompt = promptForFailure(vitest, failure)
  assert.ok(!prompt.includes('\n'))
  assert.match(prompt, /The test "sum › negatives" in src\/sum\.test\.ts:14 is failing\./)
  assert.match(prompt, /Error: AssertionError: expected 1 to be 2 - Expected \+ Received/)
  assert.match(prompt, /Reproduce with: npx vitest run src\/sum\.test\.ts -t "negatives"/)
})

test('a prefix leads the prompt', () => {
  assert.match(promptForFailure(vitest, failure, '(Test Runner, automatic round 1 of 3)'), /^\(Test Runner, automatic round 1 of 3\) The test/)
})

test('a file that failed to load says so', () => {
  const prompt = promptForFailure({ ...vitest, runner: 'jest' }, { ...failure, title: '', name: 'Test file failed to run', line: null })
  assert.match(prompt, /The test file src\/sum\.test\.ts fails before its tests run\./)
  assert.match(prompt, /Reproduce with: npx jest src\/sum\.test\.ts Fix/)
})

test('a package in a monorepo runs from its own folder', () => {
  const web: PromptProject = { id: 'apps/web:vitest', root: 'apps/web', runner: 'vitest' }
  assert.equal(
    reproduceCommand(web, ['apps/web/src/cart.test.ts'], 'adds'),
    'cd apps/web && npx vitest run src/cart.test.ts -t "adds"'
  )
})

test('each runner gets its own command', () => {
  const p = (runner: PromptProject['runner']) => ({ id: 'x', root: '', runner })
  assert.equal(reproduceCommand(p('playwright'), ['e2e/login.spec.ts'], 'logs in'), 'npx playwright test e2e/login.spec.ts -g "logs in"')
  assert.equal(reproduceCommand(p('cypress'), ['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']), 'npx cypress run --spec cypress/e2e/a.cy.ts,cypress/e2e/b.cy.ts')
  assert.equal(reproduceCommand(p('pytest'), ['tests/test_cart.py'], 'test_total'), 'python3 -m pytest tests/test_cart.py -k "test_total"')
  assert.equal(reproduceCommand(p('gradle'), ['src/test/java/com/acme/CartTest.java'], 'appliesCoupon'), './gradlew test --tests "*CartTest.appliesCoupon"')
  assert.equal(reproduceCommand(p('maven'), ['src/test/java/com/acme/CartTest.java'], 'appliesCoupon'), './mvnw test -Dtest="CartTest#appliesCoupon"')
  assert.equal(reproduceCommand(p('gradle'), []), './gradlew test')
})

test('pytest is reproduced with the Python that ran it', () => {
  const py: PromptProject = { id: 'py:pytest', root: 'py', runner: 'pytest', python: '.venv/bin/python' }
  assert.equal(reproduceCommand(py, ['py/tests/test_calc.py'], 'test_div'), 'cd py && .venv/bin/python -m pytest tests/test_calc.py -k "test_div"')
})

test("the config file's env is set in the reproduce command, quoted when it needs to be", () => {
  const web: PromptProject = { id: 'e2e:playwright', root: 'e2e', runner: 'playwright', env: { BROWSERS: '/tmp/pw', GREETING: 'hi there', 'bad-name': 'x' } }
  assert.equal(
    reproduceCommand(web, ['e2e/home.spec.ts'], 'loads'),
    'cd e2e && BROWSERS=/tmp/pw GREETING="hi there" npx playwright test home.spec.ts -g "loads"'
  )
  const long: PromptProject = { ...web, env: { TOKEN: 'x'.repeat(700) } }
  assert.equal(reproduceCommand(long, ['e2e/home.spec.ts']), 'cd e2e && npx playwright test home.spec.ts (with the env from .orca-test-runner.json set)')
})

test('several failures list each, and every file once per project', () => {
  const others = Array.from({ length: 12 }, (_, i) => ({
    ...failure,
    id: `f${i}`,
    name: `case ${i}`,
    file: i % 2 ? 'src/a.test.ts' : 'src/b.test.ts'
  }))
  const prompt = promptForFailures(new Map([[vitest.id, vitest]]), others)
  assert.ok(!prompt.includes('\n'))
  assert.match(prompt, /^12 tests are failing: "case 0" \(src\/b\.test\.ts:14\)/)
  assert.match(prompt, /and 2 more\./)
  assert.match(prompt, /Reproduce with: npx vitest run src\/b\.test\.ts src\/a\.test\.ts Fix/)
})

test('failures in two projects get a command each', () => {
  const api: PromptProject = { id: 'apps/api:jest', root: 'apps/api', runner: 'jest' }
  const prompt = promptForFailures(new Map([[vitest.id, vitest], [api.id, api]]), [
    failure,
    { ...failure, id: 'b', project: api.id, file: 'apps/api/src/user.test.ts' }
  ])
  assert.match(prompt, /npx vitest run src\/sum\.test\.ts ; \(cd apps\/api && npx jest src\/user\.test\.ts\)/)
})

test('quotes titles and paths for the shell', () => {
  assert.equal(
    reproduceCommand(vitest, ['src/my file.test.ts'], 'says "hi" for $5'),
    'npx vitest run "src/my file.test.ts" -t "says \\"hi\\" for \\\\\\$5"'
  )
})

test('-t matches the title literally: regex characters are escaped', () => {
  assert.equal(
    reproduceCommand({ ...vitest, runner: 'jest' }, ['a.test.ts'], 'returns [] for (empty) input?'),
    // The shell drops one level of backslashes inside double quotes: jest gets \[ \] \( \) \?
    'npx jest a.test.ts -t "returns \\\\[\\\\] for \\\\(empty\\\\) input\\\\?"'
  )
})

test('no newline or control character reaches the agent', () => {
  const prompt = promptForFailure(vitest, {
    ...failure,
    name: 'parses a\nb',
    title: 'parses a\nb\u001b[2K\u0003',
    message: 'Error\u001b]0;title\u0007 boom\r\n\tat x'
  })
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(prompt), JSON.stringify(prompt))
  assert.match(prompt, /-t "parses a b/)
})

test('long errors are cut short, and "fix all" stays under the terminal limit', () => {
  assert.match(promptForFailure(vitest, { ...failure, message: 'x'.repeat(2000) }), /x…/)
  const many = Array.from({ length: 50 }, (_, i) => ({
    ...failure,
    id: `f${i}`,
    name: `${'very long describe block name '.repeat(8)} case ${i}`,
    file: `packages/some-really-long-package-name/src/deeply/nested/folder/file-${i}.test.ts`
  }))
  const prompt = promptForFailures(new Map([[vitest.id, vitest]]), many)
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, String(prompt.length))
  assert.match(prompt, /50 files fail; run the whole suite/)
})
