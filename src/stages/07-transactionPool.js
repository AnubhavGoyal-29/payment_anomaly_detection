import { days, iso, isPremiumNow } from './util.js'

// Stage 7 — the transaction pool. A recurring debit that succeeds while premium is still
// live is parked rather than applied, and drained later when premium expires or credits
// run out. The pool holds ONE entry per user: a second owed cycle arriving before the
// first drains is flagged duplicate_pool_same_subscription and delivers nothing. That
// single-slot design is unchanged — only the anchor was fixed.

export default [
  {
    code: 'TP1',
    severity: 'P0',
    title: 'Two or more pool entries — single-slot collision',
    fn: (l) => {
      if (l.addedPool.length < 2) return null
      return { pooledEntries: l.addedPool.length, addedAt: l.addedPool.map(p => iso(p.addedAtMs)).join('|') }
    }
  },
  {
    code: 'TP2',
    severity: 'P0',
    title: 'Pool entry undrained while premium is expired',
    // The drain fires on premium expiry and on credit exhaustion. An entry still sitting
    // there with premium gone means neither path ran.
    fn: (l) => {
      if (!l.addedPool.length || isPremiumNow(l)) return null
      const oldest = Math.min(...l.addedPool.map(p => p.addedAtMs || l.nowMs))
      const ageDays = days(l.nowMs - oldest)
      if (ageDays < 2) return null
      return { pooledEntries: l.addedPool.length, oldestAddedAt: iso(oldest), ageDays, premiumState: l.premium?.state ?? '(no row)' }
    }
  },
  {
    code: 'TP3',
    severity: 'P0',
    title: 'Pooled debit never reached the pool table',
    // metadata.pooled marks a debit the apply path deliberately parked. With no matching
    // pool row the cycle was neither applied nor queued — it simply vanished.
    fn: (l, j) => {
      const pooled = j.paidSteps.filter(s => s.pooled)
      if (!pooled.length || l.poolRows.length >= pooled.length) return null
      return {
        pooledSteps: pooled.map(s => s.label).join('|'),
        pooledCount: pooled.length,
        poolRowsAnyState: l.poolRows.length,
        rupees: pooled.reduce((sum, s) => sum + (s.amount || 0), 0)
      }
    }
  },
  {
    code: 'TP4',
    severity: 'P1',
    eventAtKey: 'lastAt',
    title: 'Collision flagged — money taken for a cycle already queued',
    fn: (l, j) => {
      const dupes = j.paidSteps.filter(s => s.flagReason === 'duplicate_pool_same_subscription')
      if (!dupes.length) return null
      return {
        atSteps: dupes.map(s => s.label).join('|'),
        count: dupes.length,
        rupees: dupes.reduce((sum, s) => sum + (s.amount || 0), 0),
        lastAt: iso(Math.max(...dupes.map(s => s.atMs)))
      }
    }
  },
  {
    code: 'TP5',
    severity: 'P3',
    title: 'Pool entry sitting unusually long while premium is still live',
    // Legitimate — it drains when the window ends — but a very old entry suggests the
    // premium window itself is not advancing as expected.
    track: true,
    fn: (l) => {
      if (!l.addedPool.length || !isPremiumNow(l)) return null
      const oldest = Math.min(...l.addedPool.map(p => p.addedAtMs || l.nowMs))
      const ageDays = days(l.nowMs - oldest)
      if (ageDays < 45) return null
      return { ageDays, oldestAddedAt: iso(oldest), expiry: iso(l.actualExpiryMs) }
    }
  }
]
