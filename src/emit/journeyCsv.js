// The journey report: one row per user, one column group per step (t, p1, p2 ... pn).
// This is the shape that makes a broken journey readable at a glance — you can see the
// trial, then each payment, the gap between them, and where the sequence went wrong.

const MAX_STEPS = 12

export const JOURNEY_COLUMNS = [
  'product', 'cohortMonth', 'userId', 'bucket', 'planId', 'term',
  'hadTrial', 'purchases', 'rupeesCollected', 'rupeesUndelivered',
  'creditsGranted', 'creditsConsumed', 'creditsOverConsumed',
  'premiumState', 'expiry', 'creditTotal', 'creditUsed', 'subState', 'nextDueAt',
  'anomalyCount', 'maxSeverity', 'anomalyCodes',
  't_at', 't_amount', 't_state',
  ...Array.from({ length: MAX_STEPS }, (_, i) => {
    const p = `p${i + 1}`
    return [`${p}_at`, `${p}_amount`, `${p}_kind`, `${p}_gapDays`, `${p}_flag`]
  }).flat()
]

const d = ms => ms === null || ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10)

export function journeyRow ({ product, ledger: l, journey: j, found }) {
  const row = {
    product,
    cohortMonth: j.cohortMonth ?? '',
    userId: l.userId,
    bucket: l.bucket,
    planId: l.planId ?? '',
    term: l.term,
    hadTrial: j.hadTrial ? 'Y' : 'N',
    purchases: j.stepCount,
    rupeesCollected: j.rupeesCollected,
    rupeesUndelivered: j.rupeesUndelivered,
    creditsGranted: j.creditsGranted ?? '',
    creditsConsumed: j.creditsConsumed ?? '',
    creditsOverConsumed: j.creditsOverConsumed ?? '',
    premiumState: l.premium?.state ?? '',
    expiry: d(l.actualExpiryMs),
    creditTotal: l.credit?.total ?? '',
    creditUsed: l.credit?.used ?? '',
    subState: l.primarySub?.state ?? '',
    nextDueAt: d(l.primarySub?.nextDueAtMs ?? null),
    anomalyCount: found.filter(f => !f.track).length,
    maxSeverity: found.filter(f => !f.track)[0]?.severity ?? '',
    anomalyCodes: found.filter(f => !f.track).map(f => f.code).join(' ')
  }

  if (j.trial) {
    row.t_at = d(j.trial.atMs)
    row.t_amount = j.trial.amount
    row.t_state = j.trial.state
  }

  j.paidSteps.slice(0, MAX_STEPS).forEach((s, i) => {
    const p = `p${i + 1}`
    row[`${p}_at`] = d(s.atMs)
    row[`${p}_amount`] = s.amount
    row[`${p}_kind`] = s.kind === 'RECURRING_DEBIT'
      ? (s.isPostTrialFirstRecurring ? 'RECUR(1st)' : 'RECUR')
      : s.kind
    row[`${p}_gapDays`] = s.gapDaysFromPrev ?? ''
    // Only the exceptional facts, so a clean journey reads as blank across the row.
    row[`${p}_flag`] = [s.flagged ? `FLAGGED:${s.flagReason}` : '', s.pooled ? 'POOLED' : '']
      .filter(Boolean).join('+')
  })
  return row
}
