import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { changedFiles, headCommit, workspaceSignature } from './workspace-signature.ts'

const root = mkdtempSync(join(tmpdir(), 'signature-test-'))
after(() => rmSync(root, { recursive: true, force: true }))
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
writeFileSync(join(root, 'a.ts'), '1')
writeFileSync(join(root, 'b.ts'), '1')
git('init', '-q')
git('add', '.')
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')

test('no base, or a base that is gone, means "cannot say"', async () => {
  assert.equal(await changedFiles(root, null, null), null)
  assert.equal(await changedFiles(root, '0000000000000000000000000000000000000000', null), null)
  assert.equal(await changedFiles(tmpdir(), 'HEAD', null), null)
})

test('committed and uncommitted changes since the base, and removed files', async () => {
  const base = (await headCommit(root))!
  writeFileSync(join(root, 'a.ts'), '2')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'agent')
  writeFileSync(join(root, 'b.ts'), '2')
  assert.deepEqual(await changedFiles(root, base, null), { files: ['a.ts', 'b.ts'], removed: false })
  git('mv', 'b.ts', 'c.ts')
  assert.deepEqual(await changedFiles(root, base, null), { files: ['a.ts', 'c.ts'], removed: true })
})

test('untracked files count only when they changed after the last run', async () => {
  const base = (await headCommit(root))!
  writeFileSync(join(root, 'old.ts'), 'x')
  const past = new Date(Date.now() - 60_000)
  utimesSync(join(root, 'old.ts'), past, past)
  writeFileSync(join(root, 'new.ts'), 'x')
  const files = (await changedFiles(root, base, Date.now() - 10_000))!.files
  assert.ok(files.includes('new.ts') && !files.includes('old.ts'), JSON.stringify(files))
})

test('the signature follows content, not just which files are dirty', async () => {
  writeFileSync(join(root, 'a.ts'), '3')
  const one = await workspaceSignature(root)
  writeFileSync(join(root, 'a.ts'), '4')
  assert.notEqual(await workspaceSignature(root), one)
  assert.equal(await workspaceSignature(tmpdir()), null)
})
