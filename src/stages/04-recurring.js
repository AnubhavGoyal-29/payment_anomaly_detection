import { days, iso } from './util.js'
import { INIT_CRON, RETRY_LIMIT } from '../../config/products.js'

// Stage 4 — the recurring rail once it is running: the first recurring (the user's second
// full payment, whether or not a trial preceded it) and every cycle after it.
//
// Cycle length is measured between consecutive auto-debits only. A MANDATE_SETUP is the
// user buying again at the paywall and legitimately restarts the clock, and the first
// post-trial debit is deliberately scheduled at activation + 4d + 1h.

const autoDebits = j => j.paidSteps.filter(s =>
  s.kind === 'RECURRING_DEBIT' && !s.isPostTrialFirstRecurring)

export default [
  {
    code: 'R1',
    severity: 'P3',
    eventAtKey: 'occurredAt',
    // Track-only, and it has to be: the seven-day expiry floor makes short gaps a designed
    // outcome rather than a defect. A payment that lands with little of the period left now
    // grants expiry = now + 7d and sets next_due to the same date; the init cron selects
    // next_due four to five days ahead, so it fires on day two or three and the debit
    // settles on day three or four. That is a three-to-four day gap, produced deliberately,
    // and it will happen to somebody every single day.
    //
    // What used to make this check worth a P0 was never the gap. It was
    // duplicate_pool_same_subscription — money taken while a cycle was already parked, and
    // nothing delivered. Of 8,990 hits, 6,736 carried that flag and 6,735 of those sat in
    // the sub-7-day band, so the gap was only ever standing in for it. That bug stopped on
    // 1 August 2026 (fixes 8adbe60 and dff00e1, deployed 30 July) and every affected user
    // was compensated. TP4 owns what remains of it.
    //
    // Of the rest, 1,896 were merely POOLED — the pool working exactly as intended, the
    // cycle delivered on drain — and of the 358 that were neither pooled nor flagged, 135
    // had their gap measured against a MANDATE_SETUP or a post-trial debit, both of which
    // this check claims to exclude. So its own contribution was around 223 users out of
    // 8,990, on a measurement that cannot tell an early charge from a late retry.
    //
    // Kept as a monitor because a sudden rise in short cycles is still worth seeing.
    track: true,
    title: 'Consecutive debits closer together than the plan term',
    fn: (l, j) => {
      const steps = autoDebits(j)
      if (steps.length < 2) return null
      // Gaps recomputed over the filtered chain. journey.js measures every paid step against
      // whatever preceded it, MANDATE_SETUP and the post-trial debit included, so reading
      // gapDaysFromPrev here contradicted the exclusion this check declares.
      let worst = null
      for (let i = 1; i < steps.length; i++) {
        const gap = Math.round((steps[i].atMs - steps[i - 1].atMs) / 86400000)
        if (gap >= j.planDays - INIT_CRON.LEAD_DAYS_MAX) continue
        if (worst === null || gap < worst.gap) worst = { gap, step: steps[i], prev: steps[i - 1] }
      }
      if (!worst) return null
      return {
        atStep: worst.step.label,
        shortestGapDays: worst.gap,
        planDays: j.planDays,
        occurredAt: iso(worst.step.atMs),
        // Recorded so the monitor separates the three outcomes without another pass: a
        // pooled debit is delivered later, a flagged one never is, and a plain one was
        // applied straight away and is the only kind that means a genuinely short cycle.
        outcome: worst.step.flagged ? `FLAGGED:${worst.step.flagReason}` : (worst.step.pooled ? 'POOLED' : 'APPLIED'),
        prevKind: worst.prev.kind,
        totalCycles: j.stepCount
      }
    }
  },
  {
    code: 'R2',
    severity: 'P0',
    eventAtKey: 'lastAt',
    title: 'Debit collected but delivered nothing',
    // Two reasons are deliberately not counted here. duplicate_pool_same_subscription is
    // reported by TP4, which owns the pool's single-slot behaviour, so excluding it stops
    // one collision being counted twice. subscription_not_active is monitor-only by
    // decision — it is the T+1 settlement race, tracked by R6. That leaves
    // one_time_user_already_premium as the only reason this check treats as a defect.
    fn: (l, j) => {
      const flagged = j.paidSteps.filter(s =>
        s.stage === 'RECURRING' && s.flagged &&
        s.flagReason !== 'duplicate_pool_same_subscription' &&
        s.flagReason !== 'subscription_not_active')
      if (!flagged.length) return null
      return {
        atSteps: flagged.map(s => s.label).join('|'),
        count: flagged.length,
        rupees: flagged.reduce((sum, s) => sum + (s.amount || 0), 0),
        reasons: [...new Set(flagged.map(s => s.flagReason))].join('|'),
        lastAt: iso(Math.max(...flagged.map(s => s.atMs)))
      }
    }
  },
  {
    code: 'R3',
    severity: 'P2',
    title: 'Retry chain died mid-way and never resumed',
    // Attempts were made and all declined, then silence — well short of RETRY_LIMIT, so
    // the subscription was never HALTED either. The 8-12 June Razorpay 429 burst left
    // ~10k subscriptions in exactly this state.
    fn: (l, j) => {
      const s = l.primarySub
      if (!s || !['ACTIVE', 'GRACE_PERIOD'].includes(s.state) || !s.mandateRef) return null
      if (!l.recurringTxns.length) return null
      const lastAttempt = Math.max(...l.recurringTxns.map(t => t.createdAtMs || 0))
      const silentDays = days(l.nowMs - lastAttempt)
      if (silentDays < 30) return null
      // A later success means the chain recovered on its own.
      if (j.lastPaidAtMs !== null && j.lastPaidAtMs > lastAttempt) return null
      const limit = RETRY_LIMIT[l.term] || 16
      if (l.retryCount >= limit) return null
      const lastErr = l.recurringTxns
        .slice().sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))[0]
      return {
        attempts: l.recurringTxns.length,
        retryCount: l.retryCount,
        retryLimit: limit,
        silentDays,
        lastAttemptAt: iso(lastAttempt),
        lastState: lastErr?.state ?? null
      }
    }
  },
  {
    code: 'R4',
    severity: 'P2',
    title: 'Retry limit exhausted but subscription still live',
    fn: (l) => {
      const s = l.primarySub
      if (!s || !['ACTIVE', 'GRACE_PERIOD'].includes(s.state)) return null
      const limit = RETRY_LIMIT[l.term] || 16
      if (l.retryCount < limit) return null
      return { retryCount: l.retryCount, retryLimit: limit, state: s.state }
    }
  },
  {
    code: 'R5',
    severity: 'P3',
    title: 'Debit settled far later than the usual T+1',
    track: true,
    fn: (l, j) => {
      const slow = autoDebits(j).filter(s => s.settleLagHours !== null && s.settleLagHours > 72)
      if (!slow.length) return null
      return {
        atSteps: slow.map(s => s.label).join('|'),
        maxLagHours: Math.max(...slow.map(s => s.settleLagHours))
      }
    }
  },
  {
    code: 'R6',
    severity: 'P3',
    // Track-only, monitored daily. UPI autopay settles T+1, so a debit initiated while
    // the subscription was ACTIVE can land after the user has cancelled. The bank usually
    // blocks it; when it does not we flag rather than self-refund. The sharper case —
    // an OLD subscription charged after the user had already moved to a new one — is
    // UP7, which this check defers to.
    track: true,
    title: 'Debit landed after the subscription was cancelled (T+1 settlement race)',
    fn: (l, j) => {
      const bad = j.paidSteps.filter(s => s.flagReason === 'subscription_not_active')
      if (!bad.length) return null
      // No deferral to UP7 any more. This is now the single monitor for every
      // subscription_not_active payment, so it has to be complete: the multi-subscription
      // cases it used to hand off fell through both checks whenever the replacement was
      // not ACTIVE, which is most of them. UP7 stays as the sharp P1 finding and the small
      // overlap is accepted — a monitor that undercounts is worse than one that repeats.
      return {
        atSteps: bad.map(s => s.label).join('|'),
        count: bad.length,
        rupees: bad.reduce((sum, s) => sum + (s.amount || 0), 0),
        subCount: l.subs.length
      }
    }
  }
]
