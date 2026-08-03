import trial from './01-trial.js'
import postTrial from './02-postTrialFirstRecurring.js'
import upfront from './03-upfrontPayment.js'
import recurring from './04-recurring.js'
import subscription from './05-subscription.js'
import premiumUser from './06-premiumUser.js'
import transactionPool from './07-transactionPool.js'
import userCredit from './08-userCredit.js'

// The eight stages a payment passes through. 1-4 are the user's journey in order; 5-8 are
// the stores that journey writes to. Grouping this way rather than by table means a
// finding reads as "the post-trial debit stage is broken" instead of "a column
// disagrees", and it makes the population filter explicit: every check declares the
// stages it applies to and is skipped for users who never reached them.
export const STAGES = [
  { id: 1, key: 'TRIAL', title: 'Trial health', checks: trial },
  { id: 2, key: 'POST_TRIAL_FIRST_RECURRING', title: 'Post-trial first recurring health', checks: postTrial },
  { id: 3, key: 'UPFRONT', title: 'Upfront payment health', checks: upfront },
  { id: 4, key: 'RECURRING', title: 'Recurring health', checks: recurring },
  { id: 5, key: 'SUBSCRIPTION', title: 'Subscription health', checks: subscription },
  { id: 6, key: 'PREMIUM', title: 'Premium user health', checks: premiumUser },
  { id: 7, key: 'POOL', title: 'Transaction pool health', checks: transactionPool },
  { id: 8, key: 'CREDIT', title: 'User credit health', checks: userCredit }
]

export const ALL_CHECKS = STAGES.flatMap(s =>
  s.checks.map(c => ({ ...c, stage: s.key, stageId: s.id, stageTitle: s.title })))

const seen = new Set()
for (const c of ALL_CHECKS) {
  if (seen.has(c.code)) throw new Error(`duplicate check code: ${c.code}`)
  seen.add(c.code)
}

export const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }

// Every check is a pure function of (ledger, journey, prevSnapshot). Keeping IO out is
// what makes them testable against fixtures, and it is the single discipline that would
// have caught most of the false positives found by hand during the first build.
// Two kinds of check live here, and conflating them is what made the anomaly rate
// meaningless. A STATE check reads how things stand right now, so fixing the data clears
// it. An EVENT check reads something that already happened — a debit that landed late, two
// debits too close together — and a past event never stops having happened, so the finding
// survives every fix forever. T1 kept reporting 193,560 users three weeks after the bug
// behind it was fixed, purely because those trials had once been recorded wrong.
//
// An event check declares which field of its detail carries the moment, and a run may pass
// `sinceMs`. Anything older is kept in the CSV but marked track, so it stops counting
// toward "what is broken" while remaining available for "what has ever happened".
function eventAt (check, detail) {
  if (!check.eventAtKey) return null
  const raw = detail?.[check.eventAtKey]
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

export function runChecks (ledger, journey, prev, sinceMs = null) {
  const found = []
  for (const check of ALL_CHECKS) {
    if (check.needsPrev && !prev) continue
    // Population filter: a check never runs on a user who did not reach its stage.
    if (!journey.stagesReached.has(check.stage)) continue

    let detail
    try {
      detail = check.fn(ledger, journey, prev)
    } catch (err) {
      found.push({
        code: check.code,
        stage: check.stage,
        stageId: check.stageId,
        severity: 'P3',
        track: true,
        title: 'check threw',
        detail: { error: String(err?.message || err) }
      })
      continue
    }
    if (detail) {
      const atMs = eventAt(check, detail)
      const stale = sinceMs !== null && atMs !== null && atMs < sinceMs
      found.push({
        code: check.code,
        stage: check.stage,
        stageId: check.stageId,
        severity: check.severity,
        track: check.track === true || stale,
        title: check.title,
        detail: stale ? { ...detail, stale: true } : detail
      })
    }
  }
  found.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.stageId - b.stageId))
  return found
}
