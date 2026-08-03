import {
  TERM_DAYS, RETRY_LIMIT, TRIAL, GATEWAYS_IN_SCOPE,
  PAID_STATES, CYCLE_TXN_TYPES
} from '../config/products.js'

const DAY_MS = 86400000

// Production metadata is TEXT, not JSON, and a handful of rows are malformed. A parse
// failure must degrade one field rather than abort the scan.
function parseMeta (raw) {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return (v && typeof v === 'object') ? v : {}
  } catch { return {} }
}

// dateStrings is on, so every DATETIME arrives as 'YYYY-MM-DD HH:MM:SS' in UTC.
// Appending 'Z' is what makes Date.parse read it as UTC instead of local time.
function ts (v) {
  if (!v) return null
  if (typeof v !== 'string') return new Date(v).getTime() || null
  if (v.startsWith('0000-')) return null
  const ms = Date.parse(v.replace(' ', 'T') + 'Z')
  return Number.isFinite(ms) ? ms : null
}

function groupBy (rows, key) {
  const m = new Map()
  for (const r of rows) {
    const k = String(r[key])
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

function normalizeTxn (t, plans) {
  const meta = parseMeta(t.metadata)
  return {
    // The plan this particular payment bought, resolved per transaction. A user who moves
    // between plans has cycles worth different amounts of credit, and multiplying every
    // cycle by one plan's figure understates the grant for anyone who ever bought a larger
    // one — which was turning ordinary upgrades into "consumed more than granted".
    planCredits: plans?.get(t.premium_plan_id)?.credits ?? null,
    id: t.id,
    subscriptionId: t.subscription_id,
    gateway: t.gateway,
    state: t.state,
    amount: t.amount,
    planId: t.premium_plan_id,
    createdAtMs: ts(t.createdAt),
    successAtMs: ts(t.success_at),
    txnType: meta.txnType || null,
    term: meta.term || null,
    retryCount: Number.isFinite(Number(meta.retryCount)) ? Number(meta.retryCount) : null,
    pooled: meta.pooled === true,
    pooledAtMs: ts(meta.pooledAt) || (Number(meta.pooledAt) || null),
    flagged: meta.flagged !== undefined && meta.flagged !== null,
    flagReason: meta.flagReason || null,
    isPostTrialFirstRecurring: meta.isPostTrialFirstRecurring === true,
    trialSuccessAtMs: Number(meta.trialSuccessAt) || null,
    countdownFlowApplied: meta.countdownFlowApplied === true,
    refundedAmount: Number(meta.refundedAmount) || 0,
    isInternalUser: meta.isInternalUser === true
  }
}

function normalizeSub (s) {
  const meta = parseMeta(s.metadata)
  const trial = meta.trial || null
  return {
    id: s.id,
    subscriptionId: s.subscription_id,
    gateway: s.gateway,
    subscriptionType: s.subscription_type,
    state: s.state,
    planId: s.premium_plan_id,
    nextDueAtMs: ts(s.next_due_at),
    createdAtMs: ts(s.created_at),
    updatedAtMs: ts(s.updated_at),
    token: meta.token || null,
    merchantSubscriptionId: meta.merchantSubscriptionId || null,
    // Gateway-specific mandate reference. Without one the subscription can never be
    // debited; with one it is a working billing rail regardless of gateway.
    mandateRef: s.gateway === 'PHONEPE'
      ? (meta.merchantSubscriptionId || null)
      : (meta.token || null),
    term: meta.term || null,
    mandateAmount: Number(meta.mandateAmount) || null,
    lastPooledAtMs: Number(meta.lastPooledAt) || ts(meta.lastPooledAt),
    lastDebitPooled: meta.lastDebitPooled === true,
    lastPoolDrainedAtMs: Number(meta.lastPoolDrainedAt) || ts(meta.lastPoolDrainedAt),
    cancellation: meta.cancellation || null,
    trial: trial
      ? {
          mandateAmount: Number(trial.mandateAmount) || null,
          activatedAtMs: Number(trial.activatedAt) || null,
          trialExpireAtMs: Number(trial.trialExpireAt) || null,
          firstRecurringDone: trial.firstRecurringDone === true,
          bucket: Number.isFinite(Number(trial.bucket)) ? Number(trial.bucket) : null
        }
      : null
  }
}

// Chooses the subscription every rail check runs against: the live one if there is
// one, otherwise the most recently updated. Users routinely hold several rows because
// each hard-paywall repurchase creates a new subscription and cancels the old.
function pickPrimarySub (subs) {
  if (subs.length === 0) return null
  const live = subs.filter(s => ['ACTIVE', 'GRACE_PERIOD', 'PAUSED'].includes(s.state))
  // A row with no mandate reference is not a chargeable rail, so it must never shadow
  // one that is.
  const chargeable = live.filter(s => !!s.mandateRef)
  const pick = chargeable.length > 0 ? chargeable : (live.length > 0 ? live : subs)
  return pick.slice().sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0]
}

export function buildLedgers ({ users, slice, plans, nowMs, product = null }) {
  const premiumBy = groupBy(slice.premium, 'user_id')
  const creditBy = groupBy(slice.credits, 'user_id')
  const subBy = groupBy(slice.subs, 'user_id')
  const txnBy = groupBy(slice.txns, 'user_id')
  const poolBy = groupBy(slice.pool, 'user_id')
  const usageBy = groupBy(slice.creditUsage || [], 'user_id')

  return users.map(u => {
    const uid = String(u.user_id)
    const premium = (premiumBy.get(uid) || [])[0] || null
    const credit = (creditBy.get(uid) || [])[0] || null
    const subs = (subBy.get(uid) || []).map(normalizeSub)
    const txns = (txnBy.get(uid) || []).map(t => normalizeTxn(t, plans))
    const poolRows = (poolBy.get(uid) || []).map(p => ({
      id: p.id,
      state: p.state,
      planId: p.premium_plan_id,
      subscriptionId: p.subscription_id,
      addedAtMs: ts(p.added_at),
      usedAtMs: ts(p.used_at)
    }))

    const inScopeTxns = txns.filter(t => GATEWAYS_IN_SCOPE.includes(t.gateway))
    const paidTxns = inScopeTxns.filter(t => PAID_STATES.includes(t.state))

    // A refunded cycle was collected and then given back, so it must not count as
    // paid. REFUNDED is a distinct transaction state, and refundedAmount also appears
    // on partially refunded rows that are still SUCCESS.
    const cycleTxns = paidTxns
      .filter(t => CYCLE_TXN_TYPES.includes(t.txnType))
      .filter(t => t.state !== 'REFUNDED' && t.refundedAmount === 0)

    const trialTxns = inScopeTxns.filter(t => t.txnType === 'TRIAL_SETUP')
    const trialSuccessTxns = trialTxns.filter(t => t.state === 'TRIAL_SUCCESS' || t.state === 'SUCCESS')
    const oneTimeTxns = inScopeTxns.filter(t => t.txnType === 'ONE_TIME')
    const recurringTxns = inScopeTxns.filter(t => t.txnType === 'RECURRING_DEBIT')

    const primarySub = pickPrimarySub(subs)
    const activeSubs = subs.filter(s => s.state === 'ACTIVE')

    // Plan resolution order: the premium row first, then the live subscription, then the
    // most recent paid transaction. The three disagree whenever a user upgrades, and the
    // premium row is the one that says what they are actually entitled to now — the
    // subscription still carries the plan its mandate was created for. Reading the
    // subscription first made every 199→299 upgrade look like a credit overflow: the
    // balance was plan 28's correct 325 while planCredits came from plan 18's 200.
    const planId = premium?.premium_plan_id || primarySub?.planId ||
      (cycleTxns.length ? cycleTxns[cycleTxns.length - 1].planId : null)
    const plan = planId ? plans.get(planId) || null : null
    // Term still prefers the subscription: it describes the billing rhythm of the mandate
    // that will actually fire, which is what the cycle-length checks measure against.
    const term = primarySub?.term || plan?.term || 'MONTHLY'
    const planDays = TERM_DAYS[term] || 30
    const planCredits = plan?.credits || 0

    // The billing timeline is anchored on the first money of any kind, trial included,
    // because the first post-trial recurring debit pins expiry to trialSuccessAt.
    const anchorMs = paidTxns.reduce((min, t) => {
      const m = t.successAtMs || t.createdAtMs
      return (m && (min === null || m < min)) ? m : min
    }, null)

    const paidCycles = cycleTxns.length
    const expectedExpiryMs = anchorMs !== null
      ? anchorMs + (paidCycles * planDays * DAY_MS)
      : null
    const actualExpiryMs = ts(premium?.expireAt)
    const gapDays = (expectedExpiryMs !== null && actualExpiryMs !== null)
      ? Math.round((expectedExpiryMs - actualExpiryMs) / DAY_MS)
      : null

    // retryCount lives on the transaction, not the subscription, so the live count is
    // the highest value seen on any failed debit since the last success.
    const lastSuccessMs = cycleTxns.reduce((max, t) => {
      const m = t.successAtMs || t.createdAtMs
      return (m && m > max) ? m : max
    }, 0)
    const failedSinceSuccess = recurringTxns.filter(t =>
      t.state === 'FAILED' && (t.createdAtMs || 0) > lastSuccessMs)
    const retryCount = failedSinceSuccess.reduce(
      (max, t) => Math.max(max, t.retryCount ?? 0), 0)

    const addedPool = poolRows.filter(p => p.state === 'ADDED')

    return {
      userId: u.user_id,
      // Carried so a check can apply a per-product rule without the runner threading it in.
      product,
      bucket: u.bucket,
      userCreatedAtMs: ts(u.createdAt),
      userState: u.user_state,
      countryId: u.country_id,
      isCreditSystemUser: u.is_credit_system_user === 1,
      // Derived from what the user was actually offered, not from today's bucket range.
      // The trial boundary moves as the rollout widens — it was bucket 0-79 on 15 Jun and
      // 0-~94 by 15 Jul — so applying the current config to an older user misreads their
      // entire cohort. A TRIAL_SETUP transaction is proof of what they were offered;
      // absent any trial, a payment attempt means they saw the one-time paywall.
      cohort: trialTxns.length > 0
        ? 'TRIAL_ELIGIBLE'
        : (oneTimeTxns.length > 0 ? 'ONE_TIME_ONLY' : 'UNKNOWN'),
      // Kept separately: what today's config would say. A disagreement with `cohort`
      // means the rollout boundary moved since this user signed up, which is expected
      // and must not be read as an anomaly.
      cohortByCurrentConfig: (u.bucket >= TRIAL.BUCKET_MIN && u.bucket <= TRIAL.BUCKET_MAX)
        ? 'TRIAL_ELIGIBLE'
        : 'ONE_TIME_ONLY',
      isInternal: inScopeTxns.some(t => t.isInternalUser),

      // Lifetime consumption. The only part of entitlement with real history — both
      // user_credit and premium_user are overwritten in place on every grant.
      creditUsage: (() => {
        const row = (usageBy.get(uid) || [])[0]
        return row
          ? { events: Number(row.events) || 0, consumed: Number(row.consumed) || 0,
              firstUsedMs: ts(row.first_used), lastUsedMs: ts(row.last_used) }
          : null
      })(),

      premium: premium
        ? {
            state: premium.state,
            planId: premium.premium_plan_id,
            expireAtMs: actualExpiryMs,
            expireAtRaw: premium.expireAt,
            source: premium.source,
            isTrial: premium.is_trial === 1,
            updatedAtMs: ts(premium.updatedAt)
          }
        : null,
      credit: credit
        ? { total: credit.total, used: credit.used, updatedAtMs: ts(credit.updatedAt) }
        : null,

      subs,
      primarySub,
      activeSubCount: activeSubs.length,
      poolRows,
      addedPool,

      txns: inScopeTxns,
      paidTxns,
      cycleTxns,
      trialTxns,
      trialSuccessTxns,
      oneTimeTxns,
      recurringTxns,
      flaggedTxns: inScopeTxns.filter(t => t.flagged),

      plan,
      planId,
      planDays,
      planCredits,
      term,
      retryLimit: RETRY_LIMIT[term] || 16,
      retryCount,

      anchorMs,
      paidCycles,
      expectedExpiryMs,
      actualExpiryMs,
      gapDays,
      nowMs
    }
  })
}

export const _internal = { parseMeta, ts, pickPrimarySub }
