import { days, iso, isPremiumNow } from './util.js'

// Stage 3 — the hard-paywall repurchase. When credits run out premium auto-expires, the
// user hits the paywall and buys again. That purchase must supersede everything before it:
// supersedeOldAutopaysAfterNewMandateActivation cancels the old Razorpay mandate and marks
// the old subscription CANCELLED, so exactly one subscription is left live.
//
// Nothing checked this before. The previous build only tested for two ACTIVE rows after
// the fact, never whether the supersede actually ran.

export default [
  {
    code: 'UP1',
    severity: 'P0',
    title: 'Repurchase left more than one billable subscription live',
    // Two live mandates on their own are NOT a double charge. recurringDebitInit opens by
    // looking for a subscription created after this one that is still ACTIVE/GRACE_PERIOD;
    // if it finds one it cancels itself and returns SUPERSEDED before any debit row is
    // written (razorpay.js:4402, phonepe.js:2328 — both inside recurringDebitInit, ahead of
    // the RECURRING_DEBIT transaction). So in any set of live subscriptions every one but
    // the newest disarms itself the moment it comes due, and the newest is the one that
    // should be billing.
    //
    // What the guard cannot resolve is a tie: it compares createdAt with a strict >, so two
    // live subscriptions stamped at the same instant each see no newer sibling and both
    // charge. That is the only shape of this that actually takes money twice, and it is
    // what this check now looks for.
    fn: (l, j) => {
      const live = l.subs.filter(s => ['ACTIVE', 'GRACE_PERIOD'].includes(s.state))
      if (live.length < 2) return null
      const unguarded = live.filter(s =>
        !live.some(o => o.subscriptionId !== s.subscriptionId && (o.createdAtMs || 0) > (s.createdAtMs || 0)))
      if (unguarded.length < 2) return null
      return {
        liveCount: live.length,
        unguardedCount: unguarded.length,
        subscriptionIds: unguarded.map(s => s.subscriptionId).join('|'),
        gateways: [...new Set(unguarded.map(s => s.gateway))].join('|'),
        nextDueDates: unguarded.map(s => iso(s.nextDueAtMs)).join('|'),
        purchases: j.mandateSetupCount
      }
    }
  },
  {
    code: 'UP2',
    severity: 'P1',
    // Track-only, because the state it describes is deliberate. The supersede selects
    // older subscriptions in ACTIVE/INIT/GRACE_PERIOD only (razorpay.js:5234) — PAUSED is
    // left alone on purpose, so a PAUSED leftover is not a supersede that failed to finish.
    // Nor can it quietly bill: PAUSED is outside the cron's selection, and it only returns
    // to ACTIVE when the gateway says the mandate was resumed, which is normally the user
    // doing it in their UPI app. Billing a mandate the user just resumed is correct, and if
    // a newer live subscription exists by then, recurringDebitInit's guard cancels the old
    // one before any debit. Kept as a rate so a sudden rise in leftovers stays visible.
    track: true,
    title: 'Repurchase left an older subscription able to bill again',
    // Distinct from UP1: the old row may not be ACTIVE, but if it was left in a
    // non-terminal state the supersede did not complete.
    fn: (l, j) => {
      if (j.mandateSetupCount < 2 || l.subs.length < 2) return null
      const TERMINAL = ['CANCELLED', 'HALTED', 'COMPLETED', 'INACTIVE', 'REVOKED', 'EXPIRED', 'SUSPENDED']
      // INIT rows are abandoned checkouts — the user opened the payment sheet and never
      // completed the mandate. They must be dropped before ordering, not just excluded
      // from the result: leaving them in lets an abandoned attempt occupy the "newest"
      // slot and pushes the genuinely live subscription into the "should have been
      // cancelled" bucket. Users routinely leave several of these behind.
      const real = l.subs.filter(s => s.state !== 'INIT')
      if (real.length < 2) return null
      const ordered = real.slice().sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0))
      // A stale row left behind is untidy, not dangerous, as long as recurringDebitInit's
      // supersede guard would disarm it: the guard cancels a subscription that has a newer
      // ACTIVE/GRACE_PERIOD sibling, so a PAUSED leftover under a live newer mandate can
      // never bill even if the gateway reactivates it.
      //
      // It only matters where the guard has nothing to find — the user's newest row is
      // CANCELLED (they cancelled, or the supersede finished on the wrong row) and an older
      // non-terminal mandate is the last one standing. Reactivate that and it bills someone
      // who has no live subscription at all.
      const hasNewerLive = s => real.some(o =>
        (o.createdAtMs || 0) > (s.createdAtMs || 0) && ['ACTIVE', 'GRACE_PERIOD'].includes(o.state))
      const stale = ordered.slice(0, -1)
        .filter(s => !TERMINAL.includes(s.state))
        .filter(s => !hasNewerLive(s))
      if (!stale.length) return null
      return {
        purchases: j.mandateSetupCount,
        staleCount: stale.length,
        staleStates: [...new Set(stale.map(s => s.state))].join('|'),
        staleIds: stale.map(s => s.subscriptionId).join('|'),
        newestState: ordered[ordered.length - 1].state
      }
    }
  },
  {
    code: 'UP3',
    severity: 'P0',
    eventAtKey: 'lastAt',
    // Track-only: this is not a discovery. The backend already stamps flagReason on the
    // transaction at the moment it refuses delivery and emits the event to Amplitude, so
    // the case is raised where the team already watches for it. Reporting it a second time
    // here would double-count money that is already on someone's list. Kept so the rate
    // stays visible in the run summary.
    track: true,
    title: 'Upfront purchase collected but refused on delivery',
    // one_time_user_already_premium: the money was taken and the apply path deliberately
    // did nothing, so the user paid for a window they never received.
    fn: (l, j) => {
      const refused = j.paidSteps.filter(s => s.stage === 'UPFRONT' && s.flagged)
      if (!refused.length) return null
      return {
        count: refused.length,
        rupees: refused.reduce((sum, s) => sum + (s.amount || 0), 0),
        reasons: [...new Set(refused.map(s => s.flagReason))].join('|'),
        lastAt: iso(Math.max(...refused.map(s => s.atMs))),
        premiumNow: isPremiumNow(l)
      }
    }
  },
  {
    code: 'UP4',
    severity: 'P0',
    title: 'Upfront purchase delivered no premium at all',
    fn: (l, j) => {
      const paid = j.paidSteps.filter(s => s.stage === 'UPFRONT' && !s.flagged)
      if (!paid.length) return null
      if (l.premium && l.actualExpiryMs !== null) return null
      return {
        count: paid.length,
        rupees: paid.reduce((sum, s) => sum + (s.amount || 0), 0),
        lastAt: iso(Math.max(...paid.map(s => s.atMs))),
        premiumState: l.premium?.state ?? '(no row)'
      }
    }
  },
  {
    code: 'UP5',
    severity: 'P3',
    title: 'Repurchase happened while premium was still comfortably alive',
    // Buying again with plenty of the previous window left usually means the user hit the
    // paywall for a reason the credit balance does not explain.
    track: true,
    fn: (l, j) => {
      if (j.mandateSetupCount < 2) return null
      const upfront = j.paidSteps.filter(s => s.stage === 'UPFRONT')
      if (!upfront.length) return null
      const gaps = upfront.map(s => s.gapDaysFromPrev).filter(g => g !== null && g < j.planDays - 5)
      if (!gaps.length) return null
      return { purchases: j.mandateSetupCount, shortestGapDays: Math.min(...gaps), planDays: j.planDays }
    }
  },
  {
    code: 'UP7',
    severity: 'P1',
    title: 'A superseded subscription was still charged',
    // The user had already taken a newer subscription when a debit landed on an older,
    // cancelled one. Distinct from the plain T+1 settlement race (R6): here the mandate
    // was not merely cancelled, it had been replaced, so the money went to a rail the
    // user had already left. Rare — 1 of 633 observed cases once the replacement is
    // required to be ACTIVE and to predate the charge.
    fn: (l, j) => {
      const bad = j.paidSteps.filter(s => s.flagReason === 'subscription_not_active')
      if (!bad.length || l.subs.length < 2) return null
      const byId = new Map(l.subs.map(x => [x.subscriptionId, x]))
      // Two conditions, both learned the hard way. The replacement must be ACTIVE — an
      // INIT row is an abandoned checkout and a CANCELLED one was itself dropped, and
      // counting those turned 2 real cases into 120. And it must already have existed
      // when the money landed: comparing only against the old subscription's creation
      // date flagged a user whose replacement was bought two days AFTER the bad charge.
      const superseded = bad.filter(step => {
        const charged = byId.get(step.subscriptionId)
        if (!charged) return false
        return l.subs.some(other =>
          other.state === 'ACTIVE' &&
          (other.createdAtMs || 0) > (charged.createdAtMs || 0) &&
          (other.createdAtMs || 0) < step.atMs)
      })
      if (!superseded.length) return null
      return {
        count: superseded.length,
        rupees: superseded.reduce((sum, s) => sum + (s.amount || 0), 0),
        chargedSubscriptionIds: superseded.map(s => s.subscriptionId).join('|'),
        totalSubscriptions: l.subs.length
      }
    }
  },
  {
    code: 'UP6',
    severity: 'P3',
    title: 'One-time buyer holds a recurring mandate',
    // A user whose only purchases are one-time should not be carrying a live autopay.
    fn: (l, j) => {
      const hasRecurringPurchase = j.paidSteps.some(s =>
        s.kind === 'RECURRING_DEBIT' || s.kind === 'MANDATE_SETUP')
      if (hasRecurringPurchase) return null
      const live = l.subs.filter(s => ['ACTIVE', 'GRACE_PERIOD'].includes(s.state) && s.mandateRef)
      if (!live.length) return null
      return { bucket: l.bucket, subscriptionIds: live.map(s => s.subscriptionId).join('|') }
    }
  }
]
