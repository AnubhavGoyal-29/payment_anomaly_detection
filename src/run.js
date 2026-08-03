import { randomUUID } from 'node:crypto'
import { connect } from './db.js'
import { selectCohort, fetchSlice, loadPlans } from './fetch.js'
import { buildLedgers } from './ledger.js'
import { buildJourney } from './journey.js'
import { runChecks, ALL_CHECKS, STAGES, SEVERITY_ORDER } from './stages/index.js'
import { openCsv, snapshotRow, SNAPSHOT_COLUMNS, loadSnapshot } from './emit/csv.js'
import { journeyRow, JOURNEY_COLUMNS } from './emit/journeyCsv.js'
import { buildMatrix } from './emit/matrixCsv.js'
import { iso } from './stages/util.js'

function parseArgs (argv) {
  const a = {
    product: 'tarot',
    createdFrom: null,
    createdTo: null,
    limit: null,
    chunk: 4000,
    out: new URL('../output/', import.meta.url).pathname,
    snapshotIn: null,
    amplitude: false,
    // Event checks read something that already happened, so without a window they report
    // every past occurrence forever. Default 30 days: "what is breaking now", not "what
    // has ever broken". Pass --since=0 to see the whole history.
    sinceDays: 30
  }
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, '').split('=')
    if (k === 'amplitude') { a.amplitude = true; continue }
    if (v === undefined) continue
    if (k === 'limit' || k === 'chunk') a[k] = Number(v)
    else if (k === 'since') a.sinceDays = Number(String(v).replace(/d$/, ''))
    else if (k === 'from') a.createdFrom = v
    else if (k === 'to') a.createdTo = v
    else if (k === 'snapshot-in') a.snapshotIn = v
    else a[k] = v
  }
  if (!a.createdFrom || !a.createdTo) {
    throw new Error('--from=YYYY-MM-DD and --to=YYYY-MM-DD are required')
  }
  return a
}

const ANOMALY_COLUMNS = [
  'runId', 'product', 'cohortMonth', 'userId', 'bucket', 'stage', 'stageId',
  'code', 'severity', 'title', 'planId', 'purchases', 'rupeesCollected',
  'premiumState', 'expiry', 'subState', 'nextDueAt', 'detail'
]

async function main () {
  const args = parseArgs(process.argv)
  const runId = randomUUID().slice(0, 8)
  const startedMs = Date.now()
  const stamp = new Date(startedMs).toISOString().slice(0, 10)

  const { pool, database, host } = await connect(args.product)
  console.log(`runId=${runId} product=${args.product} db=${database} host=${host}`)
  console.log(`cohort: users created ${args.createdFrom} .. ${args.createdTo}`)
  console.log(`stages: ${STAGES.length}  checks: ${ALL_CHECKS.length}`)

  const prevSnapshot = loadSnapshot(args.snapshotIn)
  if (args.snapshotIn) {
    console.log(`snapshot loaded: ${prevSnapshot.size} rows`)
  } else {
    console.log(`no snapshot — delta checks skipped: ${ALL_CHECKS.filter(c => c.needsPrev).map(c => c.code).join(', ')}`)
  }

  const sinceMs = args.sinceDays > 0 ? startedMs - args.sinceDays * 86400000 : null
  console.log(sinceMs
    ? `event window: last ${args.sinceDays} days — older events kept in the CSV but not counted`
    : 'event window: off — every past occurrence counted')

  const plans = await loadPlans(pool)
  const users = await selectCohort(pool, args)
  console.log(`scan population: ${users.length} users\n`)

  const base = `${args.out}/${args.product}-${stamp}-${runId}`
  const anomalyCsv = openCsv(`${base}-anomalies.csv`, ANOMALY_COLUMNS)
  const snapshotCsv = openCsv(`${base}-snapshot.csv`, SNAPSHOT_COLUMNS)
  const journeyCsv = openCsv(`${base}-journeys.csv`, JOURNEY_COLUMNS)

  // Keyed `code|cohortMonth` so the matrix can be pivoted without a second pass.
  const matrixCounts = new Map()
  const scannedByMonth = new Map()
  const counts = new Map()        // har occurrence, stale samet — CSV se match karta hai
  const countedByCode = new Map() // sirf wo jo anomaly rate me gine gaye
  const severityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 }
  const stageCounts = new Map(STAGES.map(s => [s.key, 0]))
  let scanned = 0
  let unhealthy = 0

  // Fetch and compute overlap. Every chunk used to fetch, then compute, then fetch again,
  // so the database idled through all the CPU work and the CPU idled through all the IO.
  // The next chunk's read is started before this one is scanned, which roughly halves
  // wall-clock on top of the six queries now running in parallel.
  const chunkStarts = []
  for (let i = 0; i < users.length; i += args.chunk) chunkStarts.push(i)
  const sliceFor = idx => {
    const b = users.slice(chunkStarts[idx], chunkStarts[idx] + args.chunk)
    return fetchSlice(pool, b.map(u => u.user_id))
  }
  let pending = chunkStarts.length ? sliceFor(0) : null

  for (let ci = 0; ci < chunkStarts.length; ci++) {
    const i = chunkStarts[ci]
    const batch = users.slice(i, i + args.chunk)
    const slice = await pending
    pending = ci + 1 < chunkStarts.length ? sliceFor(ci + 1) : null
    // Read the clock per chunk, not once for the whole run. A full scan takes ~40 minutes
    // and the expiry cron keeps flipping rows while it reads: with a single start-of-run
    // timestamp, every row expiring mid-scan came back EXPIRED but compared against a
    // `now` from before its expiry, which is exactly what PU1 and PU2 look for. That
    // produced a handful of phantom P1s on every run, different ones each time.
    const ledgers = buildLedgers({ users: batch, slice, plans, nowMs: Date.now(), product: args.product })

    for (const l of ledgers) {
      scanned++
      const j = buildJourney(l)
      const month = j.cohortMonth ?? 'unknown'
      scannedByMonth.set(month, (scannedByMonth.get(month) || 0) + 1)
      snapshotCsv.write(snapshotRow(l))

      const prev = prevSnapshot.get(String(l.userId)) || null
      const found = runChecks(l, j, prev, sinceMs)
      journeyCsv.write(journeyRow({ product: args.product, ledger: l, journey: j, found }))

      if (!found.length) continue
      if (found.some(f => !f.track)) unhealthy++

      for (const f of found) {
        counts.set(f.code, (counts.get(f.code) || 0) + 1)
        if (!f.track) countedByCode.set(f.code, (countedByCode.get(f.code) || 0) + 1)
        matrixCounts.set(`${f.code}|${month}`, (matrixCounts.get(`${f.code}|${month}`) || 0) + 1)
        if (!f.track) {
          severityCounts[f.severity]++
          stageCounts.set(f.stage, (stageCounts.get(f.stage) || 0) + 1)
        }
        anomalyCsv.write({
          runId,
          product: args.product,
          cohortMonth: month,
          userId: l.userId,
          bucket: l.bucket,
          stage: f.stage,
          stageId: f.stageId,
          code: f.code,
          severity: f.severity,
          title: f.title,
          planId: l.planId ?? '',
          purchases: j.stepCount,
          rupeesCollected: j.rupeesCollected,
          premiumState: l.premium?.state ?? '',
          expiry: iso(l.actualExpiryMs),
          subState: l.primarySub?.state ?? '',
          nextDueAt: iso(l.primarySub?.nextDueAtMs ?? null),
          detail: JSON.stringify(f.detail)
        })
      }
    }
    process.stdout.write(`\r  scanned=${scanned}/${users.length} unhealthy=${unhealthy}`)
  }

  await anomalyCsv.close()
  await snapshotCsv.close()
  await journeyCsv.close()

  const byCode = new Map(ALL_CHECKS.map(c => [c.code, c]))
  const matrix = buildMatrix(
    matrixCounts, scannedByMonth,
    new Map(ALL_CHECKS.map(c => [c.code, c.stageId])),
    new Map(ALL_CHECKS.map(c => [c.code, c.title])),
    new Map(ALL_CHECKS.map(c => [c.code, c.severity])))
  const matrixCsv = openCsv(`${base}-matrix.csv`, matrix.columns)
  for (const r of matrix.rows) matrixCsv.write(r)
  await matrixCsv.close()

  console.log('\n\n──── SUMMARY ────')
  console.log(`scanned ${scanned} users · ${unhealthy} with at least one anomaly ` +
              `(${((unhealthy / Math.max(1, scanned)) * 100).toFixed(1)}%)`)
  console.log(`P0 ${severityCounts.P0} · P1 ${severityCounts.P1} · ` +
              `P2 ${severityCounts.P2} · P3 ${severityCounts.P3}\n`)

  for (const stage of STAGES) {
    const codes = ALL_CHECKS.filter(c => c.stage === stage.key)
    const hits = codes.filter(c => counts.has(c.code))
    console.log(`${stage.id}. ${stage.title}  —  ${stageCounts.get(stage.key)} flagged`)
    if (!hits.length) { console.log('     (koi hit nahi)'); continue }
    for (const c of hits.sort((a, b) =>
      (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || counts.get(b.code) - counts.get(a.code))) {
      // Two numbers, because they diverge and the gap is the point: `counted` is what the
      // anomaly rate is built from, `total` includes track-only checks and events aged out
      // of the window. Showing only one of them is how a fixed bug keeps looking alive.
      const counted = countedByCode.get(c.code) || 0
      const total = counts.get(c.code)
      const tag = (c.track || counted === 0) ? 'trk' : c.severity
      const suffix = counted === total ? '' : `  (of ${total} ever)`
      console.log(`     ${tag.padEnd(3)} ${c.code.padEnd(4)} ${String(counted || total).padStart(7)}  ${c.title}${suffix}`)
    }
  }

  const silent = ALL_CHECKS.filter(c => !counts.has(c.code)).map(c => c.code)
  if (silent.length) console.log(`\nno hits: ${silent.join(', ')}`)

  console.log(`\nreports:\n  ${base}-journeys.csv   (t, p1..pn per user)\n  ${base}-anomalies.csv\n  ${base}-matrix.csv     (cases x months)\n  ${base}-snapshot.csv`)
  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
