#!/usr/bin/env node
// skips reads vitest's JSON report and fails when a test skipped that the
// allow-list does not name for this OS, so a test that runs nowhere cannot
// go unnoticed. It prints every skipped (or todo) test with the reason it
// gave, and exits 1 when one is not listed, when the report is missing or
// unreadable, or when it holds no tests.
//
//   pnpm test:json   # vitest run, with --reporter=json into test-results/
//   pnpm skips       # node scripts/skips.mjs test-results/vitest.json scripts/allowed-skips.txt
//
// vitest's JSON report carries no skip note, so the reason shown is the
// source line that declared the test (vitest.config.ts sets
// includeTaskLocation): for it.skipIf(cond) that line holds the condition.
//
// The allow-list holds one skip per line: the OS it is allowed on, as
// Node's process.platform names it (darwin, linux, win32) or "*" for any,
// then the test ID, then "#" and why. A test ID is the test file relative
// to the repository, then each describe and the test's title, joined by
// " > ", as this script prints it. A listed skip that did not happen is
// reported, not failed on, since a skip depends on what the machine has.
//
// Flags: --os <platform> checks against another OS's lines (default: this
// one); --report-only lists skips and never fails on an unlisted one.
// Standard library only.

import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function main(argv) {
  let os = process.platform
  let reportOnly = false
  const paths = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--os') os = argv[++i]
    else if (argv[i] === '--report-only') reportOnly = true
    else paths.push(argv[i])
  }
  if (paths.length !== 2 || !os) {
    console.error('usage: skips.mjs [--os <platform>] [--report-only] <vitest.json> <allowed-skips.txt>')
    return 2
  }
  const [reportPath, allowPath] = paths

  let allowed
  try {
    allowed = readAllow(readFileSync(allowPath, 'utf8'), os)
  } catch (err) {
    console.error(`skips: ${err.message}`)
    return 2
  }

  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (err) {
    // vitest that crashed, or never ran, writes no report: no tests is not
    // a pass.
    console.log(`skips: reading the vitest JSON report: ${err.message}`)
    return 1
  }
  if (!Array.isArray(report.testResults) || !report.numTotalTests) {
    console.log('skips: the vitest JSON report holds no tests')
    return 1
  }

  const skips = []
  const ids = new Set()
  for (const file of report.testResults) {
    const rel = relative(root, file.name).split('\\').join('/')
    for (const t of file.assertionResults ?? []) {
      const id = [rel, ...t.ancestorTitles, t.title].join(' > ')
      ids.add(id)
      if (t.status === 'skipped' || t.status === 'pending' || t.status === 'todo') {
        skips.push({ id, status: t.status, reason: reason(file.name, t) })
      }
    }
  }
  skips.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const unlisted = skips.filter(s => !allowed.has(s.id))
  console.log(`skips: ${report.numTotalTests} tests on ${os}, ${skips.length} skipped, ${skips.length - unlisted.length} of them allowed`)
  for (const s of skips) {
    const mark = allowed.has(s.id) ? 'allowed' : 'NOT ALLOWED'
    const status = s.status === 'todo' ? ' (todo)' : ''
    console.log(`skips: ${mark}${status} ${s.id}: ${s.reason}`)
  }
  const skipped = new Set(skips.map(s => s.id))
  for (const id of [...allowed.keys()].sort()) {
    if (!ids.has(id)) console.log(`skips: allowed, and names no test that ran: ${id}`)
    else if (!skipped.has(id)) console.log(`skips: allowed, and it did not skip: ${id}`)
  }
  if (unlisted.length > 0 && reportOnly) {
    console.log(`skips: report-only: ${unlisted.length} unlisted, not failing`)
    return 0
  }
  return unlisted.length > 0 ? 1 : 0
}

// readAllow returns the test IDs the list allows on os, each with why.
export function readAllow(text, os) {
  const out = new Map()
  text.split(/\r?\n/).forEach((raw, i) => {
    const hash = raw.search(/(^|\s)#/)
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim()
    if (line === '') return
    const m = /^(\S+)\s+(.+)$/.exec(line)
    if (!m || !m[2].includes(' > ')) {
      throw new Error(`allow-list line ${i + 1}: want an OS and a test ID (file > ... > title), have ${JSON.stringify(raw)}`)
    }
    if (m[1] === '*' || m[1] === os) out.set(m[2], hash < 0 ? '' : raw.slice(hash).replace(/^\s*#\s*/, ''))
  })
  return out
}

// reason is the source line that declared the skipped test, where vitest
// recorded one; a skip declared on a suite or taken at run time shows the
// test's own line, marked so.
function reason(file, t) {
  const at = t.location?.line
  if (!at) return '(no reason recorded)'
  let text
  try {
    text = readFileSync(file, 'utf8').split(/\r?\n/)[at - 1]?.trim() ?? ''
  } catch {
    return `line ${at}`
  }
  if (text.length > 160) text = text.slice(0, 157) + '...'
  const where = /\.(skip|skipIf|runIf|todo)\b/.test(text) ? '' : ' (skipped by its suite or at run time)'
  return `line ${at}: ${text}${where}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
