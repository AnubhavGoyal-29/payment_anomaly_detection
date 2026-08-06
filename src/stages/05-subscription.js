import { days, iso, isSubLive, isSubStateLive } from './util.js'

// Stage 5 — the rail itself. A subscription is reachable by exactly two crons:
//   init   (recurringDebitNotif)  next_due_at in [now+4d, now+5d)   — forward only
//   status (recurringDebitExecute) next_due_at in [now-40d, now+4d] — looks backward
// Fall out of both and the subscription can never be selected again, whatever its state.

const REACH_FLOOR_DAYS = 40

// S3's tolerance. Five minutes, deliberately: a subscription coming due even an hour
// before the paid period ends is an early charge, and anything wider hides it.
const EARLY_TOLERANCE_MS = 5 * 60 * 1000

export default [
  {
    code: 'S1',
    severity: 'P3',
    // Track-only: a mandate reference occasionally fails to persist during setup and this
    // is accepted as normal operational noise. gateway-aware — PhonePe has no token and
    // identifies the mandate by merchantSubscriptionId.
    track: true,
    title: 'Live subscription with no mandate reference',
    fn: (l) => {
      const s = l.primarySub
      if (!isSubStateLive(s) || s.mandateRef) return null
      return { subscriptionId: s.subscriptionId, gateway: s.gateway, ageDays: days(l.nowMs - (s.createdAtMs || l.nowMs)) }
    }
  },
  {
    code: 'S2',
    severity: 'P2',
    title: 'Chargeable subscription outside both cron windows',
    // Unreachable forever: past the status cron's 40-day floor and, being in the past,
    // never inside the init cron's forward window either.
    fn: (l) => {
      const s = l.primarySub
      if (!isSubLive(s) || s.nextDueAtMs === null) return null
      const overdue = days(l.nowMs - s.nextDueAtMs)
      if (overdue <= REACH_FLOOR_DAYS) return null
      return { subscriptionId: s.subscriptionId, nextDueAt: iso(s.nextDueAtMs), overdueDays: overdue }
    }
  },
  {
    code: 'S3',
    severity: 'P0',
    title: 'Next due date falls before the paid period ends',
    // A subscription must never come due while the user still holds the period they paid
    // for. Every such row is an early charge, and it is the root many other findings are
    // derived from — the pool-anchor signature (next_due set to now + planDays at the
    // moment of a pooled debit) and our own revivals (next_due parked in the init window
    // without regard to a live expiry) both land here.
    //
    // The tolerance is five minutes, not five days: anything wider silently accepts a
    // shortened cycle. Every live subscription is checked, not just the primary one, since
    // a user who repurchased can be left billing on the superseded row.
    //
    // hasPoolEntry decides how the early charge ends. With the slot free the debit parks in
    // the pool and the drain realigns nextDueAt to the new expiry (transactionPool.js:166),
    // so it self-corrects after one cycle and costs the user only an early debit. With the
    // slot already occupied the debit is flagged instead — money collected, nothing
    // delivered, and no self-correction.
    fn: (l) => {
      // expireAt only means "end of paid period" while the row is ACTIVE.
      if (l.premium?.state !== 'ACTIVE' || l.actualExpiryMs === null) return null
      if (l.actualExpiryMs <= l.nowMs) return null
      const early = l.subs.filter(s =>
        isSubLive(s) && s.nextDueAtMs !== null && s.nextDueAtMs <= l.actualExpiryMs - EARLY_TOLERANCE_MS)
      if (!early.length) return null
      // An early due date on a superseded row does not become an early charge.
      // recurringDebitInit opens by looking for a subscription created after this one that
      // is still live; finding one, it cancels itself and returns SUPERSEDED before any
      // debit row is written (razorpay.js:4402, phonepe.js:2328). So a leftover with a
      // newer live sibling disarms itself on the day it comes due.
      //
      // All five findings on the first day this ran had exactly that shape — a user who
      // repurchased, the new subscription live and paid to September, the old one still
      // ACTIVE with its original due date in August. Reporting those as P0 early charges
      // buried the case that matters: a subscription with nothing newer alive to stand it
      // down, which really will bill inside a period the user has already paid for.
      // isSubStateLive, not isSubLive: the guard in the backend tests the sibling's state
      // and nothing else, so a newer subscription still stands the old one down even when
      // its own mandate reference never persisted. Asking for a mandate here would have
      // reported all four astro findings as unguarded when the code will in fact cancel
      // them — matching what recurringDebitInit does is the whole point of the filter.
      const unguarded = early.filter(s => !l.subs.some(o =>
        o.subscriptionId !== s.subscriptionId && isSubStateLive(o) && (o.createdAtMs || 0) > (s.createdAtMs || 0)))
      if (!unguarded.length) return null
      const worst = unguarded.reduce((a, b) => (a.nextDueAtMs <= b.nextDueAtMs ? a : b))
      return {
        subscriptionId: worst.subscriptionId,
        subCount: unguarded.length,
        nextDueAt: iso(worst.nextDueAtMs),
        expiry: iso(l.actualExpiryMs),
        earlyByDays: days(l.actualExpiryMs - worst.nextDueAtMs),
        alreadyDue: worst.nextDueAtMs <= l.nowMs,
        hasPoolEntry: l.addedPool.length > 0
      }
    }
  },
  {
    code: 'S4',
    severity: 'P3',
    title: 'Next due date drifted more than a full cycle past expiry',
    fn: (l) => {
      const s = l.primarySub
      if (!isSubLive(s) || s.nextDueAtMs === null) return null
      if (l.premium?.state !== 'ACTIVE' || l.actualExpiryMs === null) return null
      const lateBy = days(s.nextDueAtMs - l.actualExpiryMs)
      if (lateBy <= l.planDays) return null
      return { subscriptionId: s.subscriptionId, nextDueAt: iso(s.nextDueAtMs), lateByDays: lateBy }
    }
  },
  {
    code: 'S5',
    severity: 'P2',
    title: 'Chargeable subscription that has never been billed',
    fn: (l, j) => {
      const s = l.primarySub
      if (!isSubLive(s) || l.recurringTxns.length) return null
      // The first debit must actually be due. Without this the check fires on any
      // subscription older than ten days whose renewal is simply still in the future —
      // the same mistake E2 made before its next_due guard was added.
      if (s.nextDueAtMs === null || s.nextDueAtMs > l.nowMs) return null
      const ageDays = days(l.nowMs - (s.createdAtMs || l.nowMs))
      if (ageDays < 10) return null
      return { subscriptionId: s.subscriptionId, ageDays, nextDueAt: iso(s.nextDueAtMs), purchases: j.stepCount }
    }
  },
  {
    code: 'S6',
    severity: 'P3',
    title: 'Live subscription with no premium row',
    fn: (l) => {
      const s = l.primarySub
      if (!isSubLive(s) || l.premium) return null
      return { subscriptionId: s.subscriptionId, state: s.state }
    }
  },
  {
    code: 'S7',
    severity: 'P3',
    // Track-only. The init cron selects state='ACTIVE' so it skips these, and although the
    // status cron does select CANCELLED, the worker skips a FAILED-last-txn cancelled sub,
    // the status handler returns early on its TERMINAL_STATES list, and init refuses with
    // SUBSCRIPTION_NOT_ACTIVE. Untidy, but it cannot produce a debit.
    track: true,
    title: 'Terminal subscription still carrying a future due date',
    fn: (l) => {
      const stale = l.subs.filter(s =>
        ['CANCELLED', 'HALTED'].includes(s.state) && s.nextDueAtMs !== null && s.nextDueAtMs > l.nowMs)
      if (!stale.length) return null
      return { count: stale.length, states: [...new Set(stale.map(s => s.state))].join('|') }
    }
  }
]
