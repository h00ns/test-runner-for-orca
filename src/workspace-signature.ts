// A fingerprint of a workspace's code: equal fingerprints mean nothing changed between them.
// Content-based on purpose: `git status` alone reads the same after a second edit to a file that
// was already modified.
import { spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const GIT_TIMEOUT_MS = 10_000
const MAX_UNTRACKED = 5000

/** Streams a git command's stdout into the hash; false when git fails or times out. */
function gitInto(cwd: string, args: string[], hash: Hash | null, collect?: (chunk: Buffer) => void) {
  return new Promise<boolean>((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      hash?.update(chunk)
      collect?.(chunk)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** HEAD, the full diff against it, and each untracked file's size and mtime; null outside git. */
export async function workspaceSignature(root: string): Promise<string | null> {
  const hash = createHash('sha1')
  if (!(await gitInto(root, ['rev-parse', 'HEAD'], hash))) {
    return null
  }
  if (!(await gitInto(root, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--binary'], hash))) {
    return null
  }
  const chunks: Buffer[] = []
  if (!(await gitInto(root, ['ls-files', '--others', '--exclude-standard', '-z'], null, (c) => chunks.push(c)))) {
    return null
  }
  const untracked = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean).sort()
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    const info = await stat(join(root, file)).catch(() => null)
    hash.update(`\0${file}\0${info ? `${info.size}:${info.mtimeMs}` : 'gone'}`)
  }
  hash.update(`\0untracked:${untracked.length}`)
  return hash.digest('hex')
}

function gitText(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    void gitInto(cwd, args, null, (chunk) => chunks.push(chunk)).then((ok) =>
      resolve(ok ? Buffer.concat(chunks).toString('utf8') : null)
    )
  })
}

/** The commit the working tree sits on; null outside git. */
export async function headCommit(root: string): Promise<string | null> {
  return (await gitText(root, ['rev-parse', 'HEAD']))?.trim() || null
}

export type Changes = {
  /** Changed files that still exist, relative to the root. */
  files: string[]
  /** A changed file is gone (deleted, or renamed away): tests that imported it cannot be found. */
  removed: boolean
}

/** Files that differ from `base` (committed since, or not committed yet), plus untracked files
 *  modified after `since`. null when it cannot say: outside git, without a base, or when `base`
 *  is no longer in the history (a rebase, a reset); the caller then runs everything. */
export async function changedFiles(root: string, base: string | null, since: number | null): Promise<Changes | null> {
  if (!base) {
    return null
  }
  const diff = await gitText(root, ['diff', '--name-only', '--relative', '-z', '--no-renames', base])
  const untracked = await gitText(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (diff === null || untracked === null) {
    return null
  }
  const changed = diff.split('\0').filter(Boolean)
  const fresh: string[] = []
  for (const file of untracked.split('\0').filter(Boolean)) {
    const info = await stat(join(root, file)).catch(() => null)
    if (info && (since === null || info.mtimeMs >= since)) {
      fresh.push(file)
    }
  }
  const existing = changed.filter((file) => existsSync(join(root, file)))
  return {
    files: [...new Set([...existing, ...fresh])].sort(),
    removed: existing.length < changed.length
  }
}
