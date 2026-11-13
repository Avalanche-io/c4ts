// Scratch measurement, not for merge: the mode the c4 CLI on PATH and this
// checkout's c4ts write for a directory holding a subdirectory, a plain
// file under a subdirectory, and a read-only file.
//   node scripts/measure-modes.mjs   (after pnpm build)
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = p => pathToFileURL(join(repo, 'packages/node/dist', p)).href
const { NodeFS } = await import(dist('packages/node/src/node-fs.js'))
const { scan } = await import(dist('packages/core/src/scanner.js'))

const root = mkdtempSync(join(tmpdir(), 'measure-modes-'))
const tree = join(root, 'tree')
const home = join(root, 'home')
mkdirSync(join(tree, 'parent', 'sub'), { recursive: true })
mkdirSync(home)
writeFileSync(join(tree, 'parent', 'sub', 'plain.txt'), 'p\n')
writeFileSync(join(tree, 'parent', 'readonly.txt'), 'r\n')
chmodSync(join(tree, 'parent', 'readonly.txt'), 0o444)
mkdirSync(join(tree, 'parent', 'rodir'))
writeFileSync(join(tree, 'parent', 'rodir', 'in.txt'), 'in\n')
if (process.platform === 'win32') execFileSync('attrib', ['+R', join(tree, 'parent', 'rodir')])
else chmodSync(join(tree, 'parent', 'rodir'), 0o555)

const out = (tag, s) => s.split('\n').filter(l => l !== '').forEach(l => console.log(`MEASURE ${process.platform} ${tag} ${l}`))
for (const p of ['parent', 'parent/sub', 'parent/sub/plain.txt', 'parent/readonly.txt', 'parent/rodir']) {
  out('node-stat', `${(statSync(join(tree, p)).mode).toString(8)} ${p}`)
}
if (process.platform === 'win32') {
  out('attrib', execFileSync('attrib', [join(tree, 'parent', 'readonly.txt')], { encoding: 'utf8' }))
  out('attrib', execFileSync('attrib', [join(tree, 'parent', 'rodir')], { encoding: 'utf8' }))
}
const opts = { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, C4_STORE: join(home, 'store') } }
const chain = execFileSync('c4', ['id', tree], opts)
out('go-flat', execFileSync('c4', ['patch', '-'], { ...opts, input: chain }))
out('go-id', execFileSync('c4', ['id', '-q', tree], opts))
const m = await scan(new NodeFS(), tree)
out('c4ts', m.encode())
out('c4ts-id', (await m.computeC4ID()).toString())
chmodSync(join(tree, 'parent', 'readonly.txt'), 0o644)
if (process.platform === 'win32') execFileSync('attrib', ['-R', join(tree, 'parent', 'rodir')])
else chmodSync(join(tree, 'parent', 'rodir'), 0o755)
rmSync(root, { recursive: true, force: true })
