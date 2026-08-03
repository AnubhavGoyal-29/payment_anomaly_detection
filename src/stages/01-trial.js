import { TRIAL, T7_COHORT_FLOOR, INIT_CRON } from '../../config/products.js'
import { days, iso, HOUR_MS, initWindowFloorMs } from './util.js'

// Stage 1 — the trial. Runs only on users who actually have a TRIAL_SETUP transaction, so
// eligibility rules that shifted over time (bucket 0-79 on 15 Jun, 0-~94 by 15 Jul) never
// produce false findings on older users.

export default [
  {
    code: 'T1',
    severity: 'P0',
    // Track-only: the mismatch is a bookkeeping artifact — the transaction row carries the
    // plan amount while the gateway only ever collected the ₹1 mandate. Verified fixed on
    // 2026-08-02: across 21 days and ~350k trials on both products, every TRIAL_SUCCESS
    // row now records amount = 1. Left in place so the historical cohorts stay visible,
    // but it must not dominate the anomaly rate — it was 193,560 of 197,361 flags on the
    // 15 May - 15 June cohort.
    track: true,
    title: 'Trial charged at the wrong amount',
    fn: (l, j) => {
      const wrong = j.steps.filter(s => s.kind === 'TRIAL' && s.amount !== TRIAL.MANDATE_AMOUNT)
      if (!wrong.length) return null
      return { amounts: [...new Set(wrong.map(s => s.amount))].join('|'), expected: TRIAL.MANDATE_AMOUNT }
    }
  },
  {
    code: 'T2',
    severity: 'P1',
    title: 'Trial charged but premium never activated',
    fn: (l, j) => {
      if (!j.trial || l.premium) return null
      return { trialAt: iso(j.trial.atMs), amount: j.trial.amount }
    }
  },
  {
    code: 'T3',
    severity: 'P2',
    title: 'Trial charged but no subscription was created',
    // Without a subscription row there is no mandate to bill against, so the trial can
    // never convert no matter what else happens.
    fn: (l, j) => {
      if (!j.trial || l.subs.length) return null
      return { trialAt: iso(j.trial.atMs) }
    }
  },
  {
    code: 'T4',
    severity: 'P3',
    title: 'More than one trial for the same user',
    fn: (l, j) => {
      const trials = j.steps.filter(s => s.kind === 'TRIAL')
      if (trials.length < 2) return null
      return { count: trials.length, dates: trials.map(s => iso(s.atMs)).join('|') }
    }
  },
  {
    code: 'T5',
    severity: 'P3',
    title: 'Trial recorded under the wrong transaction state',
    // A trial settles as TRIAL_SUCCESS. One recorded as plain SUCCESS would be counted as
    // a full purchased cycle by everything downstream.
    fn: (l, j) => {
      const wrong = l.txns.filter(t => t.txnType === 'TRIAL_SETUP' && t.state === 'SUCCESS')
      if (!wrong.length) return null
      return { count: wrong.length, txnIds: wrong.map(t => t.id).join('|') }
    }
  },
  {
    code: 'T6',
    severity: 'P3',
    // Track-only: eligibility is a moving boundary, so a historical trial outside today's
    // range reflects the rollout at the time rather than a mistake.
    track: true,
    title: 'Trial granted outside the current eligible bucket range',
    fn: (l, j) => {
      if (!j.trial || j.isTrialEligibleBucket) return null
      return { bucket: l.bucket, currentRange: `${TRIAL.BUCKET_MIN}-${TRIAL.BUCKET_MAX}` }
    }
  },
  {
    code: 'T7',
    severity: 'P3',
    title: 'Unconverted trial still holding premium beyond the trial window',
    // Only meaningful while the user has bought nothing: is_trial is never cleared, so a
    // user who has since paid still reads as a trial and their expiry has moved on.
    //
    // Floored per product to users created on or after T7_COHORT_FLOOR. The historical
    // population is closed and fully explained (see the constant), and carrying it forward
    // would drown the signal in 12,414 rows that will never change. A missing floor means
    // no floor rather than a silently empty check.
    fn: (l, j) => {
      const floor = T7_COHORT_FLOOR[l.product]
      if (floor && (l.userCreatedAtMs === null || l.userCreatedAtMs < Date.parse(floor))) return null
      if (!l.premium?.isTrial || j.stepCount > 0) return null
      if (l.actualExpiryMs === null || l.actualExpiryMs <= l.nowMs) return null
      const activatedAt = l.primarySub?.trial?.activatedAtMs
      if (!activatedAt) return null
      const windowHours = Math.round((l.actualExpiryMs - activatedAt) / HOUR_MS)
      if (windowHours <= TRIAL.DURATION_HOURS) return null
      return { windowHours, maxHours: TRIAL.DURATION_HOURS, activatedAt: iso(activatedAt) }
    }
  },
  {
    code: 'T8',
    severity: 'P2',
    title: 'Trial converted but the debit can no longer be attempted',
    // A trial whose mandate is live and chargeable, whose next_due exists, and against
    // which no debit has ever been *attempted* — not merely never succeeded.
    //
    // The condition is not "already due". The init cron selects next_due in
    // [now+4d, now+5d) and that window only moves forward, so the moment next_due falls
    // below the four-day floor the subscription can never be selected again — even though
    // its due date is still in the future and it looks perfectly healthy. Testing for
    // "already due" missed 84 subscriptions across the two products that are dead today
    // and would only reveal it days later.
    //
    // The status cron cannot rescue them either: it can continue a chain, not start one,
    // and with no recurring transaction the last transaction is the TRIAL_SUCCESS, which
    // shouldNotDoRecurringStatus skips outright.
    //
    // A subscription with no usable mandate reference is excluded — it could never be
    // charged regardless, and those are counted in stage 5 instead. On Razorpay that
    // reference is the token, and the population without one has already been ruled out of
    // scope entirely.
    fn: (l, j) => {
      if (!j.trial || j.stepCount > 0) return null
      const s = l.primarySub
      if (!s || !['ACTIVE', 'GRACE_PERIOD'].includes(s.state) || !s.mandateRef) return null
      if (s.nextDueAtMs === null) return null
      if (l.recurringTxns.length > 0) return null
      // Below the init cron's floor is the point of no return, whether or not it has passed.
      // The floor is IST-midnight based, matching the cron: a rolling now+4d sits up to a
      // day later and would condemn subscriptions today's run can still select.
      if (s.nextDueAtMs >= initWindowFloorMs(l.nowMs, INIT_CRON.LEAD_DAYS_MIN)) return null
      const hoursSince = Math.round((l.nowMs - j.trial.atMs) / HOUR_MS)
      if (hoursSince < 24) return null
      return {
        trialAt: iso(j.trial.atMs),
        hoursSince,
        nextDueAt: iso(s.nextDueAtMs),
        alreadyDue: s.nextDueAtMs <= l.nowMs,
        overdueDays: days(l.nowMs - s.nextDueAtMs),
        gateway: s.gateway
      }
    }
  }
]
