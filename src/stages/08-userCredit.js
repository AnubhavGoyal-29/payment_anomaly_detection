import { days, iso, isPremiumNow } from './util.js'
import { UC1_COHORT_FLOOR } from '../../config/products.js'

// Stage 8 — credits, and the corrected entitlement rule.
//
// A credit plan sells "N messages OR planDays, whichever ends first". Days are therefore a
// cap, not the unit: a user who burns 200 messages in ten days has received everything
// they paid for, and premium ending early is correct. The earlier build measured
// entitlement in days and produced five checks that were all false for exactly this
// reason.
//
// LIMIT: there is no grant log — user_credit_usage records deductions only and user_credit
// is overwritten on every grant — so granted is derived from the payment steps and the two
// can only be compared as lifetime totals, never per step.
//
// Cancelling DURING the trial caps the balance rather than adding to it:
//   remaining = max(0, total - used); topupCredit(min(10, remaining))
// so the user keeps at most 10. That only ever reduces the balance, which is why the
// "consumed more than granted" identity still holds — but applying that cap to someone who
// has already paid a full cycle destroys entitlement, and that is exactly the bug UC9
// watches for.

export default [
  {
    code: 'UC1',
    severity: 'P1',
    title: 'Consumed more credits than were ever granted',
    // The entitlement identity, in the correct unit.
    //
    // Floored per product to users created on or after UC1_COHORT_FLOOR — the historical
    // population is closed and explained (see the constant). A missing floor means no
    // floor, so a new product is never silently excluded.
    fn: (l, j) => {
      const floor = UC1_COHORT_FLOOR[l.product]
      if (floor && (l.userCreatedAtMs === null || l.userCreatedAtMs < Date.parse(floor))) return null
      if (j.creditsOverConsumed === null || j.creditsOverConsumed <= 0) return null
      // Small overruns are expected: a reply in flight when the balance hits zero still
      // gets deducted.
      if (j.creditsOverConsumed <= 5) return null
      return {
        granted: j.creditsGranted,
        consumed: j.creditsConsumed,
        overBy: j.creditsOverConsumed,
        purchases: j.stepCount,
        planCredits: l.planCredits
      }
    }
  },
  {
    code: 'UC2',
    severity: 'P1',
    title: 'Used exceeds total on the live balance',
    fn: (l) => {
      if (!l.credit || l.credit.used <= l.credit.total) return null
      return { total: l.credit.total, used: l.credit.used, overBy: l.credit.used - l.credit.total }
    }
  },
  {
    code: 'UC3',
    severity: 'P1',
    title: 'Premium active but no credits granted',
    // Yields to UC9, which names the specific cause when the user has already paid a
    // cycle — otherwise one empty balance is reported three times over.
    fn: (l, j) => {
      if (!isPremiumNow(l) || !l.plan?.isCreditPlan) return null
      if (l.credit && l.credit.total > 0) return null
      if (j.deliveredSteps.length > 0 && (l.credit?.used ?? 0) === 0) return null
      return { creditTotal: l.credit?.total ?? '(no row)', planCredits: l.planCredits, daysLeft: days(l.actualExpiryMs - l.nowMs) }
    }
  },
  {
    code: 'UC4',
    severity: 'P1',
    title: 'Premium active with nothing left to spend',
    // creditService auto-expires the moment the balance reaches zero, so a live window
    // with an empty balance means that path did not run.
    fn: (l, j) => {
      if (!isPremiumNow(l) || !l.plan?.isCreditPlan || !l.credit) return null
      if (l.credit.total - l.credit.used > 0) return null
      // Same deferral as UC3: a paid user sitting on an untouched zero balance is UC9.
      if (j.deliveredSteps.length > 0 && l.credit.used === 0 && l.credit.total <= 10) return null
      return { total: l.credit.total, used: l.credit.used, daysLeft: days(l.actualExpiryMs - l.nowMs) }
    }
  },
  {
    code: 'UC5',
    severity: 'P3',
    title: 'Balance exceeds the plan grant',
    fn: (l) => {
      if (!l.credit || !l.plan?.isCreditPlan || !l.planCredits) return null
      if (l.credit.total <= l.planCredits) return null
      return { total: l.credit.total, planCredits: l.planCredits, planId: l.planId }
    }
  },
  {
    code: 'UC6',
    severity: 'P1',
    title: 'Credit balance fell with no cause',
    needsPrev: true,
    // The PhonePe cancellation bug looked exactly like this: total dropped from the plan
    // grant to a small remainder while the user stayed premium.
    fn: (l, j, prev) => {
      if (!prev || !l.credit || prev.creditTotal === null) return null
      if (l.credit.total >= prev.creditTotal) return null
      if (j.stepCount > (prev.paidCycles ?? 0)) return null
      if (!isPremiumNow(l) || l.planId !== prev.planId) return null
      return { previousTotal: prev.creditTotal, currentTotal: l.credit.total, droppedBy: prev.creditTotal - l.credit.total }
    }
  },
  {
    code: 'UC7',
    severity: 'P1',
    title: 'Credits disagree with the cancellation snapshot',
    // On cancel the backend records the entitlement into subscription metadata — the one
    // place "what the user had" survives independently of the live rows.
    fn: (l, j) => {
      const cancelled = l.subs
        .filter(s => s.cancellation && s.state === 'CANCELLED')
        .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0]
      if (!cancelled || !l.credit) return null
      const snap = cancelled.cancellation.userCredit
      if (!snap || !Number.isFinite(Number(snap.total))) return null
      const cancelledAtMs = cancelled.updatedAtMs || 0
      if (j.paidSteps.some(s => s.atMs > cancelledAtMs)) return null
      if (Number(snap.total) === l.credit.total) return null
      return {
        snapshotTotal: Number(snap.total),
        snapshotUsed: Number(snap.used),
        currentTotal: l.credit.total,
        currentUsed: l.credit.used,
        cancelledAt: iso(cancelledAtMs)
      }
    }
  },
  {
    code: 'UC9',
    severity: 'P0',
    title: 'Trial-cancel credit cap applied to a user who had already paid',
    // The PhonePe cancellation bug: the cap keyed on `subscriptionType === 'TRIAL'`, which
    // stays TRIAL on the old row forever, so a user who had since paid a full cycle had
    // their balance cut to 10. Now keyed on the latest transaction being TRIAL_SUCCESS.
    // A paid user sitting on a balance of 10 or less with nothing consumed is the
    // fingerprint of that cap having fired when it should not have.
    fn: (l, j) => {
      if (!l.credit || !l.plan?.isCreditPlan) return null
      // Must have bought at least one real cycle — a trial alone is allowed to end at 10.
      if (j.deliveredSteps.length === 0) return null
      // Premium must still be live. Once it expires the normal flow resets the balance to
      // 0/0 (resetUserCredit on monthly expiry), which is indistinguishable from the cap
      // by value alone — and harmless, since the entitlement had ended anyway. The cap is
      // only a defect when it destroys a window the user still holds.
      if (!isPremiumNow(l)) return null
      if (l.credit.total > 10 || l.credit.used !== 0) return null
      const cancelled = l.subs.find(s => s.state === 'CANCELLED' && s.cancellation)
      return {
        creditTotal: l.credit.total,
        creditUsed: l.credit.used,
        planCredits: l.planCredits,
        paidCycles: j.deliveredSteps.length,
        lastPaidAt: iso(j.lastPaidAtMs),
        snapshotTotal: cancelled?.cancellation?.userCredit?.total ?? null
      }
    }
  },
  {
    code: 'UC8',
    severity: 'P3',
    title: 'On a credit plan but not flagged as a credit-system user',
    fn: (l) => {
      if (!l.plan?.isCreditPlan || !isPremiumNow(l) || l.isCreditSystemUser) return null
      return { planId: l.planId, planCredits: l.planCredits, creditTotal: l.credit?.total ?? null }
    }
  }
]
