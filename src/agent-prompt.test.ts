import { assert, test } from 'orca/testing'
import { MAX_PROMPT_CHARS, promptForFailure, promptForFailures, reproduceCommand } from './agent-prompt'
import type { TestFailure } from './protocol'

const failure: TestFailure = {
  id: 'src/sum.test.ts::sum › negatives',
  file: 'src/sum.test.ts',
  name: 'sum › negatives',
  title: 'negatives',
  line: 14,
  message: 'AssertionError: expected 1 to be 2\n\n- Expected\n+ Received'
}

test('one failure becomes one line naming the test, error and a reproduce command', () => {
  const prompt = promptForFailure('vitest', failure)
  assert.ok(!prompt.includes('\n'))
  assert.match(prompt, /The test "sum › negatives" in src\/sum\.test\.ts:14 is failing\./)
  assert.match(prompt, /Error: AssertionError: expected 1 to be 2 - Expected \+ Received/)
  assert.match(prompt, /Reproduce with: npx vitest run src\/sum\.test\.ts -t "negatives"/)
})

test('a file that failed to load says so', () => {
  const prompt = promptForFailure('jest', { ...failure, title: '', name: 'Test file failed to run', line: null })
  assert.match(prompt, /The test file src\/sum\.test\.ts fails before its tests run\./)
  assert.match(prompt, /Reproduce with: npx jest src\/sum\.test\.ts Fix/)
})

test('several failures list each and every file once', () => {
  const others = Array.from({ length: 12 }, (_, i) => ({
    ...failure,
    id: `f${i}`,
    name: `case ${i}`,
    file: i % 2 ? 'src/a.test.ts' : 'src/b.test.ts'
  }))
  const prompt = promptForFailures('vitest', others)
  assert.ok(!prompt.includes('\n'))
  assert.match(prompt, /^12 tests are failing: "case 0" \(src\/b\.test\.ts:14\)/)
  assert.match(prompt, /and 2 more\./)
  assert.match(prompt, /Reproduce with: npx vitest run src\/b\.test\.ts src\/a\.test\.ts Fix/)
})

test('quotes titles and paths for the shell', () => {
  assert.equal(
    reproduceCommand('vitest', ['src/my file.test.ts'], 'says "hi" for $5'),
    'npx vitest run "src/my file.test.ts" -t "says \\"hi\\" for \\\\\\$5"'
  )
})

test('long errors are cut short', () => {
  const prompt = promptForFailure('vitest', { ...failure, message: 'x'.repeat(2000) })
  assert.ok(prompt.length < 900)
  assert.match(prompt, /x…/)
})

test('-t matches the title literally: regex characters are escaped', () => {
  assert.equal(
    reproduceCommand('jest', ['a.test.ts'], 'returns [] for (empty) input?'),
    // The shell drops one level of backslashes inside double quotes: jest gets \[ \] \( \) \?
    'npx jest a.test.ts -t "returns \\\\[\\\\] for \\\\(empty\\\\) input\\\\?"'
  )
})

test('no newline or control character reaches the agent', () => {
  const prompt = promptForFailure('vitest', {
    ...failure,
    name: 'parses a\nb',
    title: 'parses a\nb\u001b[2K\u0003',
    message: 'Error\u001b]0;title\u0007 boom\r\n\tat x'
  })
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(prompt), JSON.stringify(prompt))
  assert.match(prompt, /-t "parses a b/)
})

test('"fix all" stays under the 4096-character terminal limit', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    ...failure,
    id: `f${i}`,
    name: `${'very long describe block name '.repeat(8)} case ${i}`,
    file: `packages/some-really-long-package-name/src/deeply/nested/folder/file-${i}.test.ts`
  }))
  const prompt = promptForFailures('vitest', many)
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, String(prompt.length))
  assert.match(prompt, /50 files fail; run the whole suite/)
})
