import { TERM_DAYS, TRIAL } from '../config/products.js'

const DAY_MS = 86400000

// A user's payment history as an ordered sequence of steps: t (the trial, if any) then
// p1, p2 ... pn — one per money-taking event, in the order the money actually moved.
//
// This replaces the earlier "compare final expiry against anchor + cycles x planDays"
// model, which was wrong in both directions: premium legitimately ends early when credits
// run out, and legitimately drifts later after a lapse. An anomaly always happens at a
// specific step, so the sequence is what has to be modelled.

export const STEP_KIND = {
  TRIAL: 'TRIAL',
  MANDATE_SETUP: 'MANDATE_SETUP',
  RECURRING_DEBIT: 'RECURRING_DEBIT',
  ONE_TIME: 'ONE_TIME'
}

// Money actually collected. PENDING is an intent record — the user opened a payment page
// and may simply have abandoned it — and FAILED is a decline, so neither buys anything.
const COLLECTED = ['SUCCESS', 'TRIAL_SUCCESS']

function label (index, kind) {
  return kind === STEP_KIND.TRIAL ? 't' : `p${index}`
}

// Which lifecycle stage a step belongs to. Stage membership decides which checks may run
// against it, so a trial check can never fire on a one-time buyer and vice versa.
export function stageOf (step, journey) {
  if (step.kind === STEP_KIND.TRIAL) return 'TRIAL'
  if (step.isPostTrialFirstRecurring) return 'POST_TRIAL_FIRST_RECURRING'
  if (step.kind === STEP_KIND.ONE_TIME) return 'UPFRONT'
  // A repeat mandate is the user buying again at the hard paywall, not the rail renewing.
  if (step.kind === STEP_KIND.MANDATE_SETUP) {
    return journey.mandateSetupCount > 1 ? 'UPFRONT' : 'FIRST_PURCHASE'
  }
  return 'RECURRING'
}

export function buildJourney (ledger) {
  const collected = ledger.txns
    .filter(t => COLLECTED.includes(t.state))
    .filter(t => t.refundedAmount === 0)
    .sort((a, b) => (a.successAtMs || a.createdAtMs || 0) - (b.successAtMs || b.createdAtMs || 0))

  const mandateSetupCount = collected.filter(t => t.txnType === STEP_KIND.MANDATE_SETUP).length
  const scaffold = { mandateSetupCount }

  let paidIndex = 0
  const steps = collected.map(t => {
    const kind = t.txnType === 'TRIAL_SETUP' ? STEP_KIND.TRIAL : (t.txnType || 'UNKNOWN')
    if (kind !== STEP_KIND.TRIAL) paidIndex += 1
    const atMs = t.successAtMs || t.createdAtMs
    const step = {
      label: label(paidIndex, kind),
      kind,
      txnId: t.id,
      gateway: t.gateway,
      state: t.state,
      amount: t.amount,
      planId: t.planId,
      planCredits: t.planCredits,
      atMs,
      initiatedAtMs: t.createdAtMs,
      // Settlement lag. UPI autopay settles T+1, so a large value here means the debit
      // sat unresolved rather than that anything is wrong.
      settleLagHours: (t.createdAtMs && t.successAtMs)
        ? Math.round((t.successAtMs - t.createdAtMs) / 3600000)
        : null,
      pooled: t.pooled,
      flagged: t.flagged,
      flagReason: t.flagReason,
      isPostTrialFirstRecurring: t.isPostTrialFirstRecurring,
      postTrialFirstRecurringApplied: t.postTrialFirstRecurringApplied,
      countdownFlowApplied: t.countdownFlowApplied,
      trialSuccessAtMs: t.trialSuccessAtMs,
      retryCount: t.retryCount
    }
    step.stage = stageOf(step, scaffold)
    return step
  })

  // Gap to the previous step, which is what "was this cycle the right length" reduces to.
  // The trial is excluded from the gap chain: the first post-trial debit is deliberately
  // scheduled at activation + 4d + 1h, so its distance from the trial says nothing.
  const paidSteps = steps.filter(s => s.kind !== STEP_KIND.TRIAL)
  paidSteps.forEach((s, i) => {
    s.gapDaysFromPrev = i === 0 ? null : Math.round((s.atMs - paidSteps[i - 1].atMs) / DAY_MS)
    s.prevLabel = i === 0 ? null : paidSteps[i - 1].label
  })

  const trial = steps.find(s => s.kind === STEP_KIND.TRIAL) || null
  const term = ledger.term
  const planDays = TERM_DAYS[term] || 30

  // Entitlement, measured in credits rather than days. A credit plan sells "N messages OR
  // planDays, whichever ends first", so days cannot be the unit — a user who burns their
  // messages in ten days has received everything they paid for.
  //
  // LIMIT: there is no grant log. user_credit_usage records deductions only, and
  // user_credit is overwritten on every grant (total = planCredits, used = 0). So the
  // granted figure is *derived* from the payment steps, never observed, and the two
  // numbers can only be compared as lifetime totals — never per step. "Were the right
  // credits given at p3" is not answerable from the data as it stands.
  //
  // The trial counts as a grant. It charges Rs 1 but hands over the plan's FULL credits —
  // it only feels unlimited because nobody burns 200 messages in a 10-minute preview.
  // Omitting it made every unconverted trial user look like they had consumed credits
  // that were never granted.
  //
  // Summed per step rather than multiplied, because the plan can change between cycles.
  // Six of the six largest overruns turned out to be users who had bought a 600-credit
  // plan once among their 200-credit ones: counting all their cycles at 200 hid 400 real
  // credits each and reported them as over-consuming.
  const deliveredSteps = paidSteps.filter(s => !s.flagged)

  // A trial that settled and was then revoked still handed over the credits. Its row ends
  // up FAILED — the gateway pulls the mandate within seconds and the cancel path rewrites
  // the state — but success_at is stamped and stays, and the grant behind it is real:
  // premium was created and topupCredit ran before any of that happened. Every one of
  // these carries success_at (17 of 17 across both products) and every one of those users
  // holds credits, so reading state alone reported the whole cohort as having consumed
  // credits nobody gave them. The rest of the journey deliberately still ignores these —
  // they buy no cycle and move no expiry — so this stays scoped to the grant.
  const revokedTrialGrant = ledger.plan?.isCreditPlan && !trial
    ? ledger.txns.find(t => t.txnType === 'TRIAL_SETUP' && !COLLECTED.includes(t.state) && t.successAtMs)
    : null

  const grantingSteps = trial ? [trial, ...deliveredSteps] : deliveredSteps
  const grantingEvents = grantingSteps.length + (revokedTrialGrant ? 1 : 0)
  const creditsGranted = ledger.plan?.isCreditPlan
    ? grantingSteps.reduce((sum, s) => sum + (s.planCredits ?? ledger.planCredits ?? 0), 0) +
      (revokedTrialGrant ? (revokedTrialGrant.planCredits ?? ledger.planCredits ?? 0) : 0)
    : null
  const creditsConsumed = ledger.creditUsage?.consumed ?? null

  // Attempts that took money but delivered nothing. flagged is set by the backend when the
  // apply path deliberately refused (duplicate pool slot, subscription not active, one-time
  // while already premium).
  const flaggedSteps = paidSteps.filter(s => s.flagged)

  return {
    steps,
    trial,
    paidSteps,
    deliveredSteps,
    flaggedSteps,
    stepCount: paidSteps.length,
    mandateSetupCount,
    hadTrial: !!trial,
    firstPaidAtMs: paidSteps.length ? paidSteps[0].atMs : null,
    lastPaidAtMs: paidSteps.length ? paidSteps[paidSteps.length - 1].atMs : null,
    planDays,
    creditsGranted,
    creditsConsumed,
    // Positive means the user consumed more than was ever granted to them.
    creditsOverConsumed: (creditsGranted !== null && creditsConsumed !== null)
      ? creditsConsumed - creditsGranted
      : null,
    rupeesCollected: paidSteps.reduce((sum, s) => sum + (s.amount || 0), 0),
    rupeesUndelivered: flaggedSteps.reduce((sum, s) => sum + (s.amount || 0), 0),

    // Which stages this user actually reached. Every check declares the stages it applies
    // to, and is skipped for anyone who never got there.
    stagesReached: new Set([
      ...(trial ? ['TRIAL'] : []),
      ...steps.map(s => s.stage).filter(Boolean),
      ...(ledger.subs.length ? ['SUBSCRIPTION'] : []),
      ...(ledger.premium ? ['PREMIUM'] : []),
      ...(ledger.poolRows.length ? ['POOL'] : []),
      ...(ledger.credit || ledger.plan?.isCreditPlan ? ['CREDIT'] : [])
    ]),

    cohortMonth: ledger.userCreatedAtMs
      ? new Date(ledger.userCreatedAtMs).toISOString().slice(0, 7)
      : null,
    isTrialEligibleBucket: ledger.bucket >= TRIAL.BUCKET_MIN && ledger.bucket <= TRIAL.BUCKET_MAX
  }
}
