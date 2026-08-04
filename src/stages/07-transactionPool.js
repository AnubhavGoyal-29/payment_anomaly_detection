import { days, iso, isPremiumNow } from './util.js'
import { POOL_DRAIN_GRACE_MS } from '../../config/products.js'

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
    title: 'Pool entry undrained well after premium lapsed',
    // The drain fires on premium expiry and on credit exhaustion. An entry still sitting
    // there long after premium ran out means neither path ran.
    //
    // "Long after" is the whole check. The drain is not instant: it runs on the user's next
    // request, or on the expiry cron, which only sweeps rows already lapsed for 24 hours.
    // Between the clock running out and either of those, a parked entry under a lapsed
    // premium is the correct, healthy state — and asking `isPremiumNow` alone reports it as
    // a P0. It also cannot be answered by looking at the state column: the row stays ACTIVE
    // until the cron flips it, so a lapsed user is ACTIVE with expireAt in the past.
    //
    // Measured on the first day this ran: all 96 tarot findings had lapsed inside the very
    // hour the scan was running, none earlier — so what the check was really reporting was
    // the moment the scan happened to start, and the population turned over completely
    // every day. The same shape gave 89 on astro.
    //
    // Two hours is the deliberate choice over the cron's 24. Drains were observed landing
    // within minutes, because a user holding a pooled payment is a paying user who opens
    // the app; anything still parked after two hours has missed that path and is worth a
    // look even though the cron may yet catch it.
    fn: (l) => {
      if (!l.addedPool.length || isPremiumNow(l)) return null
      // No expiry to measure from — a pool entry with no premium row behind it at all is
      // not a fresh lapse and never resolves itself, so it is always worth reporting.
      const lapsedMs = l.actualExpiryMs === null ? Infinity : l.nowMs - l.actualExpiryMs
      if (lapsedMs < POOL_DRAIN_GRACE_MS) return null
      const oldest = Math.min(...l.addedPool.map(p => p.addedAtMs || l.nowMs))
      const ageDays = days(l.nowMs - oldest)
      if (ageDays < 2) return null
      return {
        pooledEntries: l.addedPool.length,
        oldestAddedAt: iso(oldest),
        ageDays,
        lapsedHours: lapsedMs === Infinity ? null : Math.round(lapsedMs / 3600000),
        premiumState: l.premium?.state ?? '(no row)'
      }
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
