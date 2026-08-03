import { createWriteStream, existsSync, readFileSync } from 'node:fs'

const esc = v => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function openCsv (path, columns) {
  const stream = createWriteStream(path, { flags: 'w' })
  stream.write(columns.join(',') + '\n')
  return {
    path,
    write (row) { stream.write(columns.map(c => esc(row[c])).join(',') + '\n') },
    close () { return new Promise(res => stream.end(res)) }
  }
}

// The snapshot is the previous run's ledger, and it is the only input the delta checks
// (B7 expiry went backwards, C3 credits fell) have. Without it those bugs are
// invisible — a single scan cannot tell a wrong value from a correct one.
export const SNAPSHOT_COLUMNS = [
  'userId', 'bucket', 'cohort', 'planId', 'premiumState', 'actualExpiryMs',
  'creditTotal', 'creditUsed', 'paidCycles', 'subState', 'nextDueAtMs', 'pooledCount'
]

export function snapshotRow (l) {
  return {
    userId: l.userId,
    bucket: l.bucket,
    cohort: l.cohort,
    planId: l.planId,
    premiumState: l.premium?.state ?? '',
    actualExpiryMs: l.actualExpiryMs ?? '',
    creditTotal: l.credit?.total ?? '',
    creditUsed: l.credit?.used ?? '',
    paidCycles: l.paidCycles,
    subState: l.primarySub?.state ?? '',
    nextDueAtMs: l.primarySub?.nextDueAtMs ?? '',
    pooledCount: l.addedPool.length
  }
}

export function loadSnapshot (path) {
  if (!path || !existsSync(path)) return new Map()
  const lines = readFileSync(path, 'utf8').split('\n')
  const header = lines[0].split(',')
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  const num = v => (v === '' || v === undefined) ? null : Number(v)

  const map = new Map()
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    const c = lines[i].split(',')
    map.set(String(c[idx.userId]), {
      userId: c[idx.userId],
      planId: num(c[idx.planId]),
      premiumState: c[idx.premiumState] || null,
      actualExpiryMs: num(c[idx.actualExpiryMs]),
      creditTotal: num(c[idx.creditTotal]),
      creditUsed: num(c[idx.creditUsed]),
      paidCycles: num(c[idx.paidCycles]) ?? 0,
      subState: c[idx.subState] || null,
      nextDueAtMs: num(c[idx.nextDueAtMs]),
      pooledCount: num(c[idx.pooledCount]) ?? 0
    })
  }
  return map
}
