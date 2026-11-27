import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { createLocator, decodeEntities, parseJunit, parseXml } from './junit.ts'

const root = mkdtempSync(join(tmpdir(), 'junit-test-'))
after(() => rmSync(root, { recursive: true, force: true }))
for (const file of [
  'src/test/java/com/acme/CartTest.java',
  'tests/test_cart.py',
  'e2e/login.spec.ts',
  'cypress/e2e/login.cy.ts',
  'build/should-not-be-indexed/CartTest.java'
]) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), '')
}
const locate = createLocator(root)

test('reads Gradle and Maven reports: class › method, trimmed stack, line from the stack', () => {
  const gradle = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.acme.CartTest" tests="3" skipped="1" failures="1" errors="0" time="0.02">
  <properties/>
  <testcase name="appliesCouponOnce()" classname="com.acme.CartTest" time="0.01">
    <failure message="org.opentest4j.AssertionFailedError: expected: &lt;9000&gt; but was: &lt;8000&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;9000&gt; but was: &lt;8000&gt;
	at app//org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
	at app//com.acme.CartTest.appliesCouponOnce(CartTest.java:12)
	at java.base/java.util.ArrayList.forEach(ArrayList.java:1596)
</failure>
  </testcase>
  <testcase name="addsItems()" classname="com.acme.CartTest" time="0.001"/>
  <testcase name="later()" classname="com.acme.CartTest" time="0"><skipped/></testcase>
  <system-out><![CDATA[]]></system-out>
</testsuite>`
  const report = parseJunit([gradle], { runner: 'gradle', roots: root, locate })
  assert.equal(report.passed, 1)
  assert.equal(report.failed, 1)
  assert.equal(report.skipped, 1)
  const [failure] = report.failures
  assert.equal(failure?.file, 'src/test/java/com/acme/CartTest.java')
  assert.equal(failure?.name, 'CartTest › appliesCouponOnce()')
  assert.equal(failure?.title, 'appliesCouponOnce')
  assert.equal(failure?.line, 12)
  assert.match(failure?.message ?? '', /expected: <9000> but was: <8000>/)
  assert.doesNotMatch(failure?.message ?? '', /AssertionFailureBuilder|ArrayList/)
})

test('reads pytest (xunit1): file and 0-based line attributes', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3"><testcase classname="tests.test_cart" file="tests/test_cart.py" line="4" name="test_total" time="0.001"><failure message="assert 8000 == 9000">def test_total():
&gt;       assert total() == 9000
E       assert 8000 == 9000

tests/test_cart.py:6: AssertionError</failure></testcase><testcase classname="tests.test_cart" file="tests/test_cart.py" line="8" name="test_ok" time="0.001" /><testcase classname="tests.test_cart" file="tests/test_cart.py" line="10" name="test_later"><skipped type="pytest.skip" message="later">skip</skipped></testcase></testsuite></testsuites>`
  const report = parseJunit([xml], { runner: 'pytest', roots: root, locate })
  assert.deepEqual([report.passed, report.failed, report.skipped], [1, 1, 1])
  assert.deepEqual(
    report.failures.map((f) => [f.file, f.name, f.title, f.line]),
    [['tests/test_cart.py', 'test_cart › test_total', 'test_total', 5]]
  )
  assert.match(report.failures[0]?.message ?? '', /assert 8000 == 9000/)
})

test('reads Playwright: classname is the spec path relative to its test folder', () => {
  const xml = `<testsuites id="" name="" tests="2" failures="1" skipped="0" errors="0" time="1.2">
<testsuite name="login.spec.ts" hostname="chromium" tests="2" failures="1" skipped="0" time="1.1" errors="0">
<testcase name="login › shows an error" classname="login.spec.ts" time="0.5">
<failure message="login.spec.ts:5:3 shows an error" type="FAILURE">
<![CDATA[  [chromium] › login.spec.ts:5:3 › login › shows an error

    Error: expect(received).toBe(expected)

    Expected: "Wrong password"
    Received: ""

       at ${root}/e2e/login.spec.ts:7:15
]]>
</failure>
</testcase>
<testcase name="login › logs in" classname="login.spec.ts" time="0.6"></testcase>
</testsuite>
</testsuites>`
  const report = parseJunit([xml], { runner: 'playwright', roots: root, locate })
  assert.deepEqual([report.passed, report.failed], [1, 1])
  assert.deepEqual(
    report.failures.map((f) => [f.file, f.name, f.title, f.line]),
    [['e2e/login.spec.ts', 'login › shows an error', 'login › shows an error', 5]]
  )
})

test('reads Cypress (mocha-junit-reporter): the spec file sits on a separate Root Suite', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Mocha Tests" time="1.2" tests="2" failures="1">
  <testsuite name="Root Suite" timestamp="2026-11-20T00:00:00" tests="0" file="cypress/e2e/login.cy.ts" time="0" failures="0"></testsuite>
  <testsuite name="login" timestamp="2026-11-20T00:00:00" tests="2" time="1.2" failures="1">
    <testcase name="login shows an error" time="0.5" classname="shows an error">
      <failure message="Timed out retrying after 4000ms: expected &apos;&apos; to equal &apos;Wrong password&apos;" type="AssertionError"><![CDATA[AssertionError: Timed out retrying after 4000ms
    at Context.eval (webpack://app/./cypress/e2e/login.cy.ts:8:20)]]></failure>
    </testcase>
    <testcase name="login logs in" time="0.7" classname="logs in"></testcase>
  </testsuite>
</testsuites>`
  const report = parseJunit([xml], { runner: 'cypress', roots: root, locate })
  assert.deepEqual([report.passed, report.failed], [1, 1])
  assert.deepEqual(report.failures.map((f) => [f.file, f.name, f.line]), [['cypress/e2e/login.cy.ts', 'login shows an error', 8]])
})

test('several report files make one report; repeated names get unique ids', () => {
  const one = `<testsuite name="com.acme.CartTest"><testcase name="a()" classname="com.acme.CartTest"><error message="boom">java.lang.IllegalStateException: boom</error></testcase></testsuite>`
  const report = parseJunit([one, one], { runner: 'maven', roots: root, locate })
  assert.equal(report.failed, 2)
  assert.deepEqual(
    report.failures.map((f) => f.id),
    ['src/test/java/com/acme/CartTest.java::CartTest › a()', 'src/test/java/com/acme/CartTest.java::CartTest › a()#2']
  )
})

test('a class it cannot find keeps its name as the file', () => {
  const xml = `<testsuite><testcase name="x()" classname="com.other.Missing"><failure message="m"/></testcase></testsuite>`
  assert.equal(parseJunit([xml], { runner: 'gradle', roots: root, locate }).failures[0]?.file, 'com.other.Missing')
})

test('the XML reader survives CDATA, entities, comments and junk', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &#65;&#x42; &quot;&apos;'), '<a> & AB "\'')
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a x="1"><b y=\'2\'/><![CDATA[<raw>]]>t</a></unclosed>')
  assert.equal(doc.children[0]?.attrs.x, '1')
  assert.equal(doc.children[0]?.children[0]?.attrs.y, '2')
  assert.equal(doc.children[0]?.text, '<raw>t')
  assert.equal(parseJunit(['not xml at all'], { runner: 'pytest', roots: root, locate }).total, 0)
})

test('counts per test file', () => {
  const xml = `<testsuite><testcase classname="com.acme.CartTest" name="a()"/><testcase classname="com.acme.CartTest" name="b()"><failure message="x"/></testcase><testcase classname="com.acme.CartTest" name="c()"><skipped/></testcase></testsuite>`
  assert.deepEqual(parseJunit([xml], { runner: 'gradle', roots: root, locate }).files, { 'src/test/java/com/acme/CartTest.java': [1, 1, 1] })
})

