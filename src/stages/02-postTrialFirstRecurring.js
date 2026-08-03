import { days, iso, hasMeaningfulExpiry } from './util.js'
import { EXPIRY_FLOOR_DAYS } from '../../config/products.js'

// Stage 2 — the first real debit after a trial. This is where the anchor bug lived: the
// backend pins expiry to trialSuccessAt + planDays, which is correct when the debit lands
// inside the 4-5 day lead window (97% of the time, avg 2.7-4 days) but hands the user zero
// days when the retry chain runs long. Now floored at now + 7d in both gateways.

export default [
  {
    code: 'PT1',
    severity: 'P0',
    eventAtKey: 'paidAt',
    title: 'Post-trial debit paid for a period that had already elapsed',
    // A debit landing after its own anchor is not itself a fault. Expiry is pinned to
    // trialSuccessAt + planDays, retries routinely take four to eleven days, and at roughly
    // ten a day that will never stop happening. What matters is what the user was left
    // holding once the money was taken: the backend now floors the grant at seven days, so
    // a late debit costs them time but not the whole cycle.
    //
    // So the anchor having elapsed is only the precondition. The finding is the grant being
    // short of the floor — which is what "paid ₹199 and got nothing" actually looks like.
    //
    // Only decidable while this is the user's single paid cycle. After a second payment the
    // expiry has legitimately moved on and no longer says anything about what this one gave.
    fn: (l, j) => {
      const step = j.paidSteps.find(s => s.isPostTrialFirstRecurring)
      if (!step || !step.trialSuccessAtMs) return null
      const anchorMs = step.trialSuccessAtMs + j.planDays * 86400000
      if (anchorMs > step.atMs) return null
      if (j.stepCount !== 1) return null
      if (!hasMeaningfulExpiry(l) || l.actualExpiryMs === null) return null
      const grantedDays = Math.round((l.actualExpiryMs - step.atMs) / 86400000)
      if (grantedDays >= EXPIRY_FLOOR_DAYS) return null
      return {
        trialSuccessAt: iso(step.trialSuccessAtMs),
        anchorWouldBe: iso(anchorMs),
        paidAt: iso(step.atMs),
        daysLate: days(step.atMs - anchorMs),
        grantedDays,
        floorDays: EXPIRY_FLOOR_DAYS,
        expiry: iso(l.actualExpiryMs),
        rupees: step.amount
      }
    }
  },
  {
    code: 'PT2',
    severity: 'P1',
    title: 'Post-trial debit granted less than the trial anchor called for',
    // Only decidable while this is the user's single paid cycle — after a second payment
    // the expiry has legitimately moved on and says nothing about what this one gave.
    //
    // Two things it deliberately does not report. An expiry LATER than the anchor is not a
    // defect: nobody lost anything, and it is what the seven-day floor produces whenever a
    // debit lands close to the anchor date. Across 199 hits not one user had received less
    // — every single one had received more, in two groups: two to seven days extra, which
    // is exactly the floor, and thirty-nine to forty, which is our own remediation adding a
    // month. Guarding only on `expected <= paidAt` missed the floor case entirely, because
    // the floor also applies when the payment arrives shortly BEFORE the anchor.
    fn: (l, j) => {
      const step = j.paidSteps.find(s => s.isPostTrialFirstRecurring)
      if (!step || !step.trialSuccessAtMs || j.stepCount !== 1) return null
      if (!hasMeaningfulExpiry(l) || l.actualExpiryMs === null) return null
      const anchorMs = step.trialSuccessAtMs + j.planDays * 86400000
      // An elapsed anchor is PT1's territory.
      if (anchorMs <= step.atMs) return null
      // What the backend should have granted: the anchor, or the floor if that is further out.
      const expected = Math.max(anchorMs, step.atMs + EXPIRY_FLOOR_DAYS * 86400000)
      const shortBy = days(expected - l.actualExpiryMs)
      // Only a shortfall is a finding. Anything at or beyond `expected` cost the user nothing.
      if (shortBy <= 1) return null
      return {
        expectedExpiry: iso(expected),
        actualExpiry: iso(l.actualExpiryMs),
        shortByDays: shortBy,
        paidAt: iso(step.atMs),
        anchorWouldBe: iso(anchorMs),
        rupees: step.amount
      }
    }
  },
  {
    code: 'PT3',
    severity: 'P2',
    title: 'Post-trial debit took an unusually long retry chain',
    // Not a defect on its own, but the condition that turns the anchor into a zero-day
    // grant. Worth watching as a leading indicator rather than a failure.
    track: true,
    fn: (l, j) => {
      const step = j.paidSteps.find(s => s.isPostTrialFirstRecurring)
      if (!step || !step.trialSuccessAtMs) return null
      const gap = days(step.atMs - step.trialSuccessAtMs)
      if (gap < 15) return null
      return { daysFromTrialToPayment: gap, retryCount: step.retryCount }
    }
  },
  {
    code: 'PT4',
    severity: 'P1',
    eventAtKey: 'paidAt',
    title: 'Trial converted but the first debit delivered nothing',
    // subscription_not_active is monitor-only by decision: UPI autopay settles T+1, so a
    // debit fired an hour after the trial lands ~25-28h later, and a cancellation inside
    // that window is a race we watch rather than treat as a defect. R6 carries the volume.
    fn: (l, j) => {
      const step = j.paidSteps.find(s => s.isPostTrialFirstRecurring)
      if (!step || !step.flagged) return null
      if (step.flagReason === 'subscription_not_active') return null
      return { flagReason: step.flagReason, rupees: step.amount, paidAt: iso(step.atMs) }
    }
  },
  {
    code: 'PT5',
    severity: 'P3',
    eventAtKey: 'paidAt',
    // The stage-2 twin of R6, and it has to exist separately: checks only run on users who
    // reached their stage, and a user whose only paid step is the post-trial debit never
    // reaches RECURRING — so R6 would never see them and the settlement race would go
    // completely unrecorded rather than merely uncounted.
    track: true,
    title: 'Post-trial debit landed after the subscription was cancelled (T+1 race)',
    fn: (l, j) => {
      const step = j.paidSteps.find(s => s.isPostTrialFirstRecurring)
      if (!step || step.flagReason !== 'subscription_not_active') return null
      return {
        rupees: step.amount,
        paidAt: iso(step.atMs),
        settleHours: step.settleLagHours,
        subCount: l.subs.length
      }
    }
  }
]
