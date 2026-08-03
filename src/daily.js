// Day-over-day reporting. Reads the anomalies CSV a run just produced, records which users
// each check is holding, and compares that against the previous day's record.
//
// The comparison is on user IDs, never on counts. A count says nothing on its own: every
// state check empties as the underlying data is repaired, so its number falls whether or
// not anything new broke. UC9 sat at 7 yesterday; three were repaired today. Had three new
// ones appeared, the count would read 7 again and a count-based report would have called
// that "no change" while three more people sat on a paid cycle with no credits.
//
// So the flag is `today \ yesterday` — users this check is holding that it was not holding
// before. Everything else is context:
//
//   NEW       users the check gained     -> this is the alert
//   RESOLVED  users the check lost       -> informational, and see the note on collapse
//   RATES     track-only checks          -> a percentage, never an alert
//
// Track-only checks are excluded from the flag by construction, not by convention: the
// track flag lives on the check definition and is read from there.
//
// Usage:
//   node src/run.js   --product=tarot --from=2025-01-01 --to=2026-08-05   # the scan
//   node src/daily.js --product=tarot                                      # this, instantly
//
// The second command finds the newest anomalies CSV for that product on its own, so a run
// can be repeated and re-reported without arguments changing.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_CHECKS } from './stages/index.js'

const OUT_DIR = new URL('../output/', import.meta.url).pathname
const STATE_DIR = join(OUT_DIR, 'daily')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=')
  return [k, v === undefined ? true : v]
}))
const PRODUCT = args.product
if (!PRODUCT) throw new Error('--product=tarot|astro required')

const META = new Map(ALL_CHECKS.map(c => [c.code, {
  severity: c.severity,
  track: c.track === true,
  kind: c.eventAtKey ? 'EVENT' : (c.needsPrev ? 'DELTA' : 'STATE'),
  title: c.title
}]))

// Fields before `detail` never contain a comma today, but `detail` is JSON and always
// does, and a title could grow one at any time. Parsing properly costs four lines and
// removes the whole class of "the report silently shifted by one column".
function parseCsvLine (line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

// Filenames carry the run date but several runs share one, so order by mtime.
function newestFile (suffix) {
  const files = readdirSync(OUT_DIR)
    .filter(f => f.startsWith(`${PRODUCT}-`) && f.endsWith(suffix))
    .map(f => ({ path: join(OUT_DIR, f), m: statSync(join(OUT_DIR, f)).mtimeMs }))
  if (!files.length) return null
  return files.sort((a, b) => b.m - a.m)[0].path
}

const anomaliesPath = args.anomalies || newestFile('-anomalies.csv')
if (!anomaliesPath) throw new Error(`no anomalies CSV found for '${PRODUCT}' in ${OUT_DIR}`)

// Users scanned comes from the matrix, which is written only when a run completes. Its
// absence means the run was killed part-way, and a partial population would report every
// missing user as resolved — so refuse rather than publish a false all-clear.
// Derived from the anomalies path rather than looked up separately: the two must come from
// the same run, and "newest matrix" can easily belong to a different one.
const matrixPath = args.matrix || anomaliesPath.replace(/-anomalies\.csv$/, '-matrix.csv')
let scanned = null
if (matrixPath && existsSync(matrixPath)) {
  const row = readFileSync(matrixPath, 'utf8').split('\n').find(l => l.includes('USERS SCANNED'))
  if (row) scanned = Number(parseCsvLine(row).at(-1)) || null
}
if (!scanned && !args.force) {
  throw new Error('no completed matrix CSV alongside this run — the scan may have been interrupted. ' +
    'Re-run the scan, or pass --force to report anyway (counts will be understated).')
}

// ── today ────────────────────────────────────────────────────────────────────────────────
const lines = readFileSync(anomaliesPath, 'utf8').split('\n')
const header = parseCsvLine(lines[0])
const iUser = header.indexOf('userId')
const iCode = header.indexOf('code')
if (iUser < 0 || iCode < 0) throw new Error('anomalies CSV missing userId/code columns')

const byCheck = new Map()
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue
  const row = parseCsvLine(lines[i])
  const code = row[iCode]
  const user = row[iUser]
  if (!code || !user) continue
  if (!byCheck.has(code)) byCheck.set(code, new Set())
  byCheck.get(code).add(user)
}

// Dated by when the scan finished, not by when this is run, so re-reporting an old run
// cannot overwrite today's state with yesterday's findings.
const today = args.date || new Date(statSync(anomaliesPath).mtimeMs).toISOString().slice(0, 10)

const state = { product: PRODUCT, date: today, scanned, anomaliesFile: anomaliesPath.split('/').pop(), checks: {} }
for (const [code, users] of byCheck) {
  const meta = META.get(code)
  // Track-only checks are a rate, so only the count is kept. That also keeps the state file
  // small: the ghost-user and terminal-subscription counts run to ninety thousand each.
  state.checks[code] = meta?.track
    ? { count: users.size }
    : { count: users.size, ids: [...users].sort() }
}
// A check that found nothing must still be recorded as zero. Without this it is
// indistinguishable from a check that was deleted, and tomorrow's diff would treat its
// first finding as normal rather than as the check waking up.
for (const c of ALL_CHECKS) {
  if (!state.checks[c.code]) state.checks[c.code] = c.track === true ? { count: 0 } : { count: 0, ids: [] }
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
const statePath = join(STATE_DIR, `${PRODUCT}-${today}-state.json`)

// ── yesterday ────────────────────────────────────────────────────────────────────────────
const priors = readdirSync(STATE_DIR)
  .filter(f => f.startsWith(`${PRODUCT}-`) && f.endsWith('-state.json'))
  .filter(f => f < `${PRODUCT}-${today}-state.json`)
  .sort()
const prevPath = priors.length ? join(STATE_DIR, priors.at(-1)) : null
const prev = prevPath ? JSON.parse(readFileSync(prevPath, 'utf8')) : null

writeFileSync(statePath, JSON.stringify(state))

// ── report ───────────────────────────────────────────────────────────────────────────────
const pct = (n) => scanned ? `${((n / scanned) * 100).toFixed(2)}%` : '—'
const lines_ = []
const say = (s = '') => { lines_.push(s); console.log(s) }

say(`${PRODUCT}  ${today}   scanned ${scanned ? scanned.toLocaleString('en-IN') : '?'}`)
say(`  run   : ${state.anomaliesFile}`)
say(`  vs    : ${prev ? `${prev.date} (${prev.scanned ? prev.scanned.toLocaleString('en-IN') : '?'} scanned)` : 'nothing — this is the baseline'}`)
say()

if (!prev) {
  say('BASELINE — no previous day to compare against. Today\'s holdings recorded; the first')
  say('diff arrives on the next run.')
  say()
  const flagging = ALL_CHECKS.filter(c => c.track !== true)
    .map(c => ({ c, n: state.checks[c.code].count })).filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n)
  say(`  holding (${flagging.length} checks):`)
  for (const { c, n } of flagging) say(`    ${c.code.padEnd(5)} ${c.severity}  ${String(n).padStart(7)}   ${c.title}`)
} else {
  const gained = []
  const lost = []
  for (const c of ALL_CHECKS) {
    if (c.track === true) continue
    const nowIds = new Set(state.checks[c.code].ids || [])
    const thenIds = new Set(prev.checks?.[c.code]?.ids || [])
    const isNew = [...nowIds].filter(id => !thenIds.has(id))
    const isGone = [...thenIds].filter(id => !nowIds.has(id))
    if (isNew.length) gained.push({ c, ids: isNew })
    if (isGone.length) lost.push({ c, ids: isGone, before: thenIds.size, after: nowIds.size })
  }

  const order = { P0: 0, P1: 1, P2: 2, P3: 3 }
  gained.sort((a, b) => (order[a.c.severity] - order[b.c.severity]) || (b.ids.length - a.ids.length))

  if (!gained.length) {
    say('NEW      none — no check is holding a user it was not holding yesterday.')
  } else {
    say(`NEW      ${gained.reduce((s, g) => s + g.ids.length, 0)} across ${gained.length} check(s) — this is the alert`)
    for (const { c, ids } of gained) {
      say(`  ${c.severity}  ${c.code.padEnd(5)} +${String(ids.length).padStart(5)}   ${c.title}`)
      say(`         ${ids.slice(0, 12).join(' ')}${ids.length > 12 ? ` … +${ids.length - 12} more` : ''}`)
    }
  }
  say()

  if (lost.length) {
    say('RESOLVED (informational)')
    for (const { c, ids, before, after } of lost) {
      // A check emptying completely in one day is far more often a broken check — a schema
      // change, a query that now throws, a population filtered out by an edit — than a day
      // on which every one of its findings was repaired. Say so rather than reporting it as
      // good news.
      const collapsed = after === 0 && before >= 10 ? '   <-- emptied completely; verify the check still works' : ''
      say(`  ${c.code.padEnd(5)} -${String(ids.length).padStart(5)}  (${before} -> ${after})${collapsed}`)
    }
    say()
  }

  if (scanned && prev.scanned && Math.abs(scanned - prev.scanned) / prev.scanned > 0.02) {
    say(`NOTE     population moved ${prev.scanned.toLocaleString('en-IN')} -> ${scanned.toLocaleString('en-IN')}; ` +
        'a large swing usually means the cohort bounds differed between runs, which makes NEW and RESOLVED unreliable.')
    say()
  }
}

const tracked = ALL_CHECKS.filter(c => c.track === true)
  .map(c => ({ c, n: state.checks[c.code].count })).filter(x => x.n > 0)
  .sort((a, b) => b.n - a.n)
if (tracked.length) {
  say('RATES (track-only, never an alert)')
  for (const { c, n } of tracked) {
    const before = prev?.checks?.[c.code]?.count
    const move = before === undefined ? '' : `  (${before >= 0 ? (n - before >= 0 ? '+' : '') + (n - before) : ''})`
    say(`  ${c.code.padEnd(5)} ${String(n).padStart(7)}  ${pct(n).padStart(7)}${move}   ${c.title}`)
  }
}

const reportPath = join(STATE_DIR, `${PRODUCT}-${today}-report.txt`)
writeFileSync(reportPath, lines_.join('\n') + '\n')
console.log(`\nstate : ${statePath}`)
console.log(`report: ${reportPath}`)
