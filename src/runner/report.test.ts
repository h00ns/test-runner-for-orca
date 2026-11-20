import { assert, test } from 'orca/testing'
import { lineFromMessage, parseReport, stripAnsi, trimStack, workspaceRelative } from './report'

const root = '/work/app'

test('counts results and keeps failures with their file and line', () => {
  const parsed = parseReport(
    {
      testResults: [
        {
          name: '/work/app/src/sum.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            { title: 'adds', ancestorTitles: ['sum'], status: 'passed', failureMessages: [] },
            {
              title: 'handles negatives',
              ancestorTitles: ['sum', 'edge cases'],
              status: 'failed',
              failureMessages: [
                '\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n    at /work/app/src/sum.test.ts:14:7'
              ]
            },
            { title: 'later', ancestorTitles: ['sum'], status: 'todo', failureMessages: [] },
            { title: 'skipped', ancestorTitles: [], status: 'pending', failureMessages: [] }
          ]
        }
      ]
    },
    root
  )
  assert.equal(parsed.passed, 1)
  assert.equal(parsed.failed, 1)
  assert.equal(parsed.skipped, 2)
  assert.equal(parsed.total, 4)
  assert.deepEqual(parsed.failures, [
    {
      id: 'src/sum.test.ts::sum › edge cases › handles negatives',
      file: 'src/sum.test.ts',
      name: 'sum › edge cases › handles negatives',
      title: 'handles negatives',
      line: 14,
      message: 'AssertionError: expected 1 to be 2\n    at /work/app/src/sum.test.ts:14:7'
    }
  ])
})

test('prefers the reported location over the stack', () => {
  const parsed = parseReport(
    {
      testResults: [
        {
          name: '/work/app/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              title: 't',
              status: 'failed',
              location: { line: 3, column: 1 },
              failureMessages: ['at /work/app/a.test.ts:9:1']
            }
          ]
        }
      ]
    },
    root
  )
  assert.equal(parsed.failures[0]?.line, 3)
})

test('reports a file that failed before its tests ran', () => {
  const parsed = parseReport(
    {
      testResults: [
        {
          name: '/work/app/src/broken.test.ts',
          status: 'failed',
          message: "Error: Cannot find module './missing'\n at /work/app/src/broken.test.ts:1:1",
          assertionResults: []
        }
      ]
    },
    root
  )
  assert.equal(parsed.failed, 1)
  assert.equal(parsed.failures[0]?.name, 'Test file failed to run')
  assert.equal(parsed.failures[0]?.title, '')
  assert.equal(parsed.failures[0]?.line, 1)
  assert.match(parsed.failures[0]?.message ?? '', /Cannot find module/)
})

test('caps the number of failures it keeps', () => {
  const assertionResults = Array.from({ length: 60 }, (_, i) => ({
    title: `t${i}`,
    status: 'failed',
    failureMessages: ['boom']
  }))
  const parsed = parseReport(
    { testResults: [{ name: '/work/app/x.test.ts', status: 'failed', assertionResults }] },
    root
  )
  assert.equal(parsed.failed, 60)
  assert.equal(parsed.failures.length, 50)
  assert.equal(parsed.failuresTruncated, true)
})

test('rejects something that is not a report', () => {
  assert.throws(() => parseReport({ hello: 1 }, root), /testResults/)
})

test('helpers', () => {
  assert.equal(stripAnsi('\u001b[1m\u001b[31mred\u001b[39m\u001b[22m'), 'red')
  assert.equal(workspaceRelative('/work/app/', '/work/app/src/a.ts'), 'src/a.ts')
  assert.equal(workspaceRelative('C:\\work\\app', 'C:\\work\\app\\src\\a.ts'), 'src/a.ts')
  assert.equal(workspaceRelative('/work/app', '/elsewhere/a.ts'), '/elsewhere/a.ts')
  assert.equal(lineFromMessage('at /x/my.test.ts:42:3', '/x/my.test.ts'), 42)
  assert.equal(lineFromMessage('no stack here', '/x/my.test.ts'), null)
})

test('drops runner and Node frames from stacks, keeping the test file frames', () => {
  const stack = [
    'AssertionError: expected -2 to be -3',
    '    at /work/app/src/sum.test.ts:5:55',
    '    at file:///work/app/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11',
    '    at new Promise (<anonymous>)',
    '    at processTicksAndRejections (node:internal/process/task_queues:104:5)',
    '    at Object.<anonymous> (src/broken.test.js:2:28)'
  ].join('\n')
  assert.equal(
    trimStack(stack),
    [
      'AssertionError: expected -2 to be -3',
      '    at /work/app/src/sum.test.ts:5:55',
      '    at Object.<anonymous> (src/broken.test.js:2:28)'
    ].join('\n')
  )
})

test('repeated tests get unique ids', () => {
  const twice = { title: 't', ancestorTitles: ['s'], status: 'failed', failureMessages: ['x'] }
  const parsed = parseReport(
    { testResults: [{ name: '/work/app/a.test.ts', status: 'failed', assertionResults: [twice, twice] }] },
    root
  )
  assert.deepEqual(parsed.failures.map((f) => f.id), ['a.test.ts::s › t', 'a.test.ts::s › t#2'])
})

test('names are one line and capped', () => {
  const parsed = parseReport(
    {
      testResults: [
        { name: '/work/app/a.test.ts', status: 'failed', assertionResults: [{ title: `x\n${'y'.repeat(900)}`, status: 'failed' }] }
      ]
    },
    root
  )
  const name = parsed.failures[0]?.name ?? ''
  assert.ok(!name.includes('\n'))
  assert.ok(name.length <= 300)
})

test('paths resolve against the real path and ignore case where the file system does', () => {
  assert.equal(workspaceRelative(['/link/app', '/real/app'], '/real/app/src/a.ts'), 'src/a.ts')
  assert.equal(workspaceRelative('/Users/me/App', '/users/me/app/a.ts', true), 'a.ts')
  assert.equal(workspaceRelative('/Users/me/App', '/users/me/app/a.ts', false), '/users/me/app/a.ts')
})
