// Reads JUnit XML, the report Gradle, Maven, pytest, Playwright and Cypress can all write.
// Dependency-free: a small tokenizer is enough for the elements these reports use.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RunnerKind } from '../protocol.ts'
import {
  clip,
  lineFromMessage,
  MAX_FAILURES,
  MAX_ID_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_NAME_CHARS,
  stripAnsi,
  trimStack,
  truncate,
  workspaceRelative,
  type ParsedFailure,
  type ParsedReport
} from './report.ts'

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const MAX_TEXT = 20_000

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : ''
      }
    }
  })
}

/** A forgiving parse: unknown or unbalanced tags never throw, they just end up nested oddly. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const top = () => stack[stack.length - 1]!
  const addText = (text: string) => {
    const node = top()
    if (node.text.length < MAX_TEXT) {
      node.text += text.slice(0, MAX_TEXT - node.text.length)
    }
  }
  for (const match of xml.matchAll(TOKEN)) {
    const [, cdata, closing, opening, attrText, selfClosing, text] = match
    if (cdata !== undefined) {
      addText(cdata)
    } else if (closing) {
      const index = stack.map((n) => n.name).lastIndexOf(closing)
      if (index > 0) {
        stack.length = index
      }
    } else if (opening) {
      const attrs: Record<string, string> = {}
      for (const [, key, double, single] of (attrText ?? '').matchAll(ATTR)) {
        attrs[key!] = decodeEntities(double ?? single ?? '')
      }
      const node: XmlNode = { name: opening, attrs, children: [], text: '' }
      top().children.push(node)
      if (!selfClosing) {
        stack.push(node)
      }
    } else if (text !== undefined && text.trim()) {
      addText(decodeEntities(text))
    }
  }
  return root
}

/** Maps what a report names (a file path, a Java class, a Python module) to a file. */
export type Locate = (ref: { classname: string; file?: string }) => string | null

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', 'dist', 'out', '.gradle', '.venv', 'venv', '__pycache__', '.idea'])
const MAX_INDEXED = 30_000

/** A lazy index of the files under `cwd`, by name. */
export function createLocator(cwd: string): Locate {
  let index: Map<string, string[]> | null = null
  const build = () => {
    const byName = new Map<string, string[]>()
    let count = 0
    const walk = (rel: string, depth: number) => {
      if (count > MAX_INDEXED || depth > 12) {
        return
      }
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(join(cwd, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path, depth + 1)
          }
        } else if (entry.isFile()) {
          count += 1
          const list = byName.get(entry.name) ?? []
          list.push(path)
          byName.set(entry.name, list)
        }
      }
    }
    walk('', 0)
    return byName
  }
  const find = (name: string, hint: string): string | null => {
    index ??= build()
    const candidates = index.get(name) ?? []
    const best = candidates.find((path) => path.endsWith(hint)) ?? (candidates.length === 1 ? candidates[0] : null)
    return best ? join(cwd, best) : null
  }
  return ({ classname, file }) => {
    for (const ref of [file, classname]) {
      if (!ref) {
        continue
      }
      const path = ref.replace(/\\/g, '/').replace(/^\.\//, '')
      if (path.includes('/') || /\.(m?[jt]sx?|py|java|kt|rb|go)$/.test(path)) {
        const found = find(path.split('/').pop()!, path)
        if (found) {
          return found
        }
        continue
      }
      // A dotted name: com.acme.CartTest$Inner (JVM) or tests.test_cart.TestCart (pytest).
      const parts = path.split('$')[0]!.split('.')
      for (const ext of ['java', 'kt', 'groovy', 'scala']) {
        const simple = parts[parts.length - 1]!
        const found = find(`${simple}.${ext}`, `${parts.join('/')}.${ext}`)
        if (found) {
          return found
        }
      }
      for (let end = parts.length; end > 0; end -= 1) {
        const found = find(`${parts[end - 1]}.py`, `${parts.slice(0, end).join('/')}.py`)
        if (found) {
          return found
        }
      }
    }
    return null
  }
}

function lastSegment(classname: string): string {
  return classname.split('$')[0]!.split('.').pop() ?? classname
}

function collectCases(node: XmlNode, suites: XmlNode[], out: { testcase: XmlNode; suites: XmlNode[] }[]) {
  for (const child of node.children) {
    if (child.name === 'testsuite' || child.name === 'testsuites') {
      collectCases(child, child.name === 'testsuite' ? [...suites, child] : suites, out)
    } else if (child.name === 'testcase') {
      out.push({ testcase: child, suites })
    } else {
      collectCases(child, suites, out)
    }
  }
}

function findFileAttr(node: XmlNode): string | undefined {
  if (node.name === 'testsuite' && node.attrs.file) {
    return node.attrs.file
  }
  for (const child of node.children) {
    const found = findFileAttr(child)
    if (found) {
      return found
    }
  }
  return undefined
}

function caseMessage(problem: XmlNode): string {
  const message = problem.attrs.message ?? ''
  const body = problem.text.trim()
  const text = body.includes(message) || !message ? body || message : `${message}\n${body}`
  return trimStack(stripAnsi(text)).trim()
}

/** Every JUnit file of one run, as one report. `roots` makes paths workspace-relative. */
export function parseJunit(
  xmls: readonly string[],
  options: { runner: RunnerKind; roots: string | readonly string[]; locate: Locate }
): ParsedReport {
  const cases: { testcase: XmlNode; suites: XmlNode[]; docFile?: string }[] = []
  for (const xml of xmls) {
    const doc = parseXml(xml)
    const found: { testcase: XmlNode; suites: XmlNode[] }[] = []
    collectCases(doc, [], found)
    // Cypress (mocha-junit-reporter) names the spec only on an empty "Root Suite" beside the tests.
    const docFile = findFileAttr(doc)
    cases.push(...found.map((c) => ({ ...c, docFile })))
  }
  const classStyle = options.runner === 'gradle' || options.runner === 'maven' || options.runner === 'pytest'
  const failures: ParsedFailure[] = []
  const seen = new Map<string, number>()
  let passed = 0
  let failed = 0
  let skipped = 0
  let truncated = false
  const ran = new Set<string>()
  const fileOf = (testcase: XmlNode, suites: XmlNode[], docFile: string | undefined) => {
    const classname = testcase.attrs.classname ?? ''
    const fileAttr = testcase.attrs.file ?? [...suites].reverse().find((s) => s.attrs.file)?.attrs.file ?? docFile
    const absolute = options.locate({ classname, file: fileAttr })
    return { absolute, file: absolute ? workspaceRelative(options.roots, absolute) : fileAttr ?? classname }
  }

  for (const { testcase, suites, docFile } of cases) {
    const located = fileOf(testcase, suites, docFile)
    ran.add(located.file)
    const problem = testcase.children.find((c) => c.name === 'failure' || c.name === 'error')
    if (!problem) {
      if (testcase.children.some((c) => c.name === 'skipped')) {
        skipped += 1
      } else {
        passed += 1
      }
      continue
    }
    failed += 1
    if (failures.length >= MAX_FAILURES) {
      truncated = true
      continue
    }
    const classname = testcase.attrs.classname ?? ''
    const title = testcase.attrs.name ?? ''
    const { absolute, file } = located
    // Playwright runs a test once per browser project and names it in the suite's hostname.
    const browser = options.runner === 'playwright' ? ([...suites].reverse().find((s) => s.attrs.hostname)?.attrs.hostname ?? '') : ''
    const name = clip(classStyle && classname ? `${lastSegment(classname)} › ${title}` : title || classname, MAX_NAME_CHARS)
    const message = caseMessage(problem)
    const lineAttr = Number(testcase.attrs.line)
    const line =
      (options.runner === 'pytest' && Number.isFinite(lineAttr) && testcase.attrs.line !== undefined ? lineAttr + 1 : null) ??
      (absolute ? lineFromMessage(message, absolute) : null)
    let id = clip(`${file}::${name}${browser ? ` [${browser}]` : ''}`, MAX_ID_CHARS)
    const count = (seen.get(id) ?? 0) + 1
    seen.set(id, count)
    if (count > 1) {
      id = `${id}#${count}`
    }
    failures.push({
      id,
      file,
      name,
      // Java and pytest filter by method/function name; JS runners by the full title.
      title: classStyle ? title.replace(/\(.*\)$/, '') : title,
      line,
      message: truncate(message || 'The test failed without a message.', MAX_MESSAGE_CHARS)
    })
  }
  return { passed, failed, skipped, total: passed + failed + skipped, failures, failuresTruncated: truncated, files: [...ran] }
}
