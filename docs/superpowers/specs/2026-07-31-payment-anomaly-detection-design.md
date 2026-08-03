# Payment Anomaly Detection — Design

**Date:** 2026-07-31
**Products:** tarot99 (`tarrot99-backend`) · astro99 (`livo-backend`)
**Status:** implemented and sanity-checked against production read replicas for both
products. Amplitude emit and the H-domain trends are not built yet.

---

## 1. Purpose

Every payment bug found during the 2026-07-30/31 investigation was discovered by hand, weeks
or months after it started costing money. This system detects them continuously instead.

It answers one question per user: **did this user get exactly what they paid for?** — and, when
the answer is no, says precisely which invariant broke.

It is **read-only and detect-only.** It never writes to a product database and never remediates.

---

## 2. Scope

### In
- Gateways `RAZORPAY_OD` and `PHONEPE` only. Note the `_OD` suffix — there is no bare
  `RAZORPAY` value in production.
- Both products, same code, product-specific config.

### Out
- `APPLE_IAPS` and `GOOGLE_PLAY`. Their premium lifecycle is owned by the store, not by our
  code, so our expiry and credit invariants would false-fire on them.
- **Exclusion is per-user, not per-row.** Any user holding *any* Apple or Google subscription
  row is dropped from the scan entirely — a gateway filter on the transaction alone is not
  enough, because the store still drives that user's `premium_user` state.

### Scan population
Users with a Razorpay/PhonePe payment footprint: a row in `transaction`, `premium_user`, or
`payment_subscription`. Not the full ~5M user table.

`user.bucket` is a real column and is authoritative. `userId % 100` appears only as a
fallback in `isUserEligibleForTrial` and must not be used as the primary source.

---

## 3. Cohort model

`user.bucket` is the authoritative source. `userId % 100` is only a fallback
(`premiumUser.js:296`) and must not be used as the primary.

| cohort | rule |
|---|---|
| `TRIAL_ELIGIBLE` | bucket 0–94 |
| `ONE_TIME_ONLY` | bucket 95–99 |

Trial eligibility is gated by `CONSTANTS.TRIAL.ELIGIBILITY` (bucket range + app ≥ 1.3.2).
The plan flag `metadata.allowTrial` is **not** consulted by `isUserEligibleForTrial` — every
credit plan carries `allowTrial: false` while trials run on plan 18. Do not rely on that flag.

Orthogonal to cohort, each user has a **lifecycle stage** derived at scan time:
`NEVER_PAID · TRIAL_ACTIVE · TRIAL_LAPSED · PAYING · DUNNING · CANCELLED · HALTED · CHURNED`.

---

## 4. The ledger

One object per user, assembled from five tables, then handed to every check.

Almost nothing useful is a column. `transaction.txnType`, `retryCount`, `pooled`,
`flagged`/`flagReason`, `isPostTrialFirstRecurring`, `refundedAmount`;
`payment_subscription.token` and `.trial`; and `premium_plan.creditsIncluded` all live
inside `metadata` TEXT and must be JSON-parsed defensively.

```
IN    transaction            SUCCESS / TRIAL_SUCCESS / FAILED / PENDING / REFUNDED,
                             by txnType, amounts, timestamps, flags
OUT   premium_user           state, expireAt, source, premium_plan_id
      user_credit            total, used, is_credit_system_user
QUEUE transaction_pool       ADDED entries, count, oldest added_at
RAIL  payment_subscription   state, next_due_at, retry_count, token, term, gateway
PREV  snapshot CSV           yesterday's ledger — required for delta checks
```

### Master identity

```
paid_cycles     = SUCCESS transactions with txnType MANDATE_SETUP | RECURRING_DEBIT
anchor          = first SUCCESS or TRIAL_SUCCESS success_at
expected_expiry = anchor + (paid_cycles × plan_days)
actual_expiry   = premium_user.expireAt
gap_days        = expected_expiry − actual_expiry
```

`gap_days ≠ 0` means money and days have diverged. Every other check is a drill-down that
names *why*. This is the same rule the pool-orphan remediation used, which is why it is trusted.

**`expireAt` means two different things.** While the row is ACTIVE it is the end of the
paid period. The moment premium expires, both the lazy path (`premiumUser.js:124`) and
the hourly cron (`dataAccessor.expireActivePremiumUser`) rewrite it to `new Date()` —
an intentional "moment of first flip" audit semantic, not a bug. On an EXPIRED row it
therefore records when the flip happened, which for the 177k backlog can be months
after the real expiry. Any check comparing expiry against the purchased timeline must
run on ACTIVE rows only; entitlement for expired users is reconstructible solely from
the transaction timeline.

---

## 5. Severity

| | meaning |
|---|---|
| **P0** | money taken, nothing delivered — the user is actively out of pocket |
| **P1** | user paid but was under-delivered |
| **P2** | billing has silently stopped — revenue loss to the company |
| **P3** | state inconsistency with no present user impact |

---

## 6. Check catalogue

45 per-user checks across 7 domains, plus 6 aggregate trends. Noise is deliberately retained
for now; tuning happens once real distributions are visible.

### A — Money vs value
| code | check | sev |
|---|---|---|
| A1 | SUCCESS transaction with neither a premium extension nor a pool entry | P0 |
| A2 | `actual_expiry < expected_expiry − 1d` | P1 |
| A3 | `actual_expiry > expected_expiry + 1d` (over-delivery is also a bug) | P3 |
| A4 | flagged transaction — all three reasons: `duplicate_pool_same_subscription` (6,764), `subscription_not_active` (606), `one_time_user_already_premium` (8) | P0 |
| A5 | pool entry `ADDED` for > 2 days while premium is expired | P0 |
| A6 | two or more `ADDED` pool entries for one user (single-slot collision) | P0 |
| A7 | premium ACTIVE but `user_credit.total = 0` | P1 |
| A8 | debit marked `metadata.pooled` with no matching `transaction_pool` row | P0 |

### B — Premium state machine
| code | check | sev |
|---|---|---|
| B1 | `state = ACTIVE` but `expireAt < now − 24h` (expiry cron missed it) | P3 |
| B2 | `state = EXPIRED` but `expireAt > now` | P1 |
| B3 | ACTIVE with `expireAt` null or `0000-00-00` | P3 |
| B4 | `expireAt > now + 400d` | P3 |
| B5 | ACTIVE with null `premium_plan_id` | P3 |
| B6 | ACTIVE but no SUCCESS payment has ever landed | P3 |
| B7 | expiry moved **backwards** since yesterday's snapshot | P1 |

### C — Credits
| code | check | sev |
|---|---|---|
| C1 | `used > total` | P1 |
| C2 | `total > plan_credits` | P3 |
| C3 | `total` fell since yesterday with no expiry, cancellation, or plan change | P1 |
| C4 | credits remain but premium is EXPIRED | P3 |
| C5 | credits `0/0` while premium is ACTIVE with days left — paid and cannot chat | P1 |
| C6 | `is_credit_system_user = false` on a credit plan | P1 |

### D — Subscription / billing rail
| code | check | sev |
|---|---|---|
| D1 | ACTIVE subscription whose `token` is NULL — can never be charged | P2 |
| D2 | ACTIVE, `next_due < now − 4d`, no PENDING transaction — below the init cron's window, permanently stuck | P2 |
| D3 | `next_due < expiry − 5d` — compressed cycle | P0 |
| D4 | `next_due > expiry + plan_days` — drift | P3 |
| D5 | `retry_count ≥ RETRY_LIMIT` but still ACTIVE — dunning chain broken | P2 |
| D6 | two or more ACTIVE subscriptions for one user — supersede failed | P0 |
| D7 | subscription ACTIVE but no `premium_user` row | P3 |
| D8 | gap between consecutive SUCCESS debits `< plan_days − 5` — over-billing | P0 |
| D9 | CANCELLED subscription but premium running past the paid period | P3 |

### E — Trial cohort (bucket 0–94)
| code | check | sev |
|---|---|---|
| E1 | TRIAL_SUCCESS but no subscription was created | P2 |
| E2 | TRIAL_SUCCESS > 24h old, subscription ACTIVE, no recurring debit ever attempted | P2 |
| E3 | trial charged an amount other than ₹1 | P0 |
| E4 | trial granted to bucket 95+ | P3 |
| E5 | same user received two trials | P3 |
| E6 | TRIAL_SUCCESS but premium never activated | P1 |
| E7 | countdown trial where `expireAt` was not overwritten to now + 10/15 min | P3 |
| E8 | first recurring debit not anchored on `trialSuccessAt + plan_days` | P1 |

### F — One-time cohort (bucket 95+)
| code | check | sev |
|---|---|---|
| F1 | one-time SUCCESS delivered no premium and no credits | P0 |
| F2 | one-time user holds a recurring subscription | P3 |
| F3 | one-time user has a pool entry — the pool is recurring-only | P3 |

### G — Cancellation
| code | check | sev |
|---|---|---|
| G1 | credits changed after cancellation — current values disagree with the metadata snapshot | P1 |
| G2 | cancelled at the gateway but ACTIVE in the DB, or the reverse | P2 |

### H — Aggregate trends
`H1` debit success rate · `H2` daily count per anomaly code · `H3` median observed cycle
length vs `plan_days` · `H4` pool add-rate vs drain-rate · `H5` revenue per premium-day ·
`H6` trial→paid conversion.

### Coverage of known bugs
| bug | caught by |
|---|---|
| Pool anchored on `now` (25-day cycle) | D3, D8 |
| Stale ACTIVE premium | B1 |
| Single-slot pool collision | A4, A6 |
| Trial dead zone | E2 |
| PhonePe credit-cap corruption | C3, G1 |
| Permanently stuck subscriptions | D2, D5 |
| Mandates with NULL token | D1 |

---

## 7. Architecture

Standalone Node project at `~/payment-anomaly-detection`, independent of both backends.

```
config/products.js      per-product: DB credentials, plan map, constants, Amplitude key
config/constants.js     RETRY_LIMIT, buffers, thresholds
src/db.js               read-replica pool per product
src/fetch/userSlice.js  batched loader — a userId range → raw rows from all five tables
src/ledger.js           raw rows → normalized ledger
src/checks/*.js         money · premium · credits · subscription · trial · oneTime · cancellation
src/checks/index.js     registry: code → { fn, severity, domain, cohorts }
src/snapshot.js         read yesterday's CSV · write today's
src/emit/csv.js
src/emit/amplitude.js
src/trends.js           H1–H6
src/run.js              orchestrator
output/                 CSVs
```

**Every check is a pure function** `(ledger, prev) => anomaly | null`. No IO, no DB. This is
the central constraint: it makes checks unit-testable against fixtures and stops the dry and
live paths from ever diverging — the failure mode that produced the `--skip-latest-pooled`
error during remediation.

Adding a check is one file-local function plus one registry entry.

---

## 8. Output

### CSV (per product, per run)
| file | contents |
|---|---|
| `snapshot-{product}-{date}.csv` | the full ledger — tomorrow's input for C3 and B7 |
| `anomalies-{product}-{date}.csv` | one row per user × anomaly |
| `summary-{product}-{date}.csv` | counts per code and severity |

### Amplitude
Off by default during development (`--amplitude` opts in).

**`payment_health`** — one per scanned user per run.
`product · bucket · cohort · stage · gateway · plan_id · is_healthy · anomaly_count ·
anomaly_codes[] · max_severity · paid_cycles · expected_expiry · actual_expiry · gap_days ·
credits_total · credits_used · sub_state · next_due_at · pool_added`

**`payment_anomaly`** — one per user × anomaly.
`code · severity · domain · detail`

`insert_id = {runId}_{userId}_{code}` so a re-run cannot double-count.

---

## 9. Development plan

1. Build against production **read replicas**, emitting CSV only.
2. Review the distributions by hand: which codes fire, at what volume, which are noise.
3. Tune thresholds and retire genuinely useless checks.
4. Only once the output is trusted end-to-end: enable Amplitude and move to production, in
   one step.

No production deployment work until step 4.

---

## 10. Open questions

Deferred deliberately — they refine thresholds but do not change the structure, and are
better answered against real scan output than by reading code.

- The observed ~3-day retry spacing versus code that retries immediately on FAILED. The
  `PENDING < 60h` guard is the likely cause but is unconfirmed. D5's threshold depends on it.
- Why ~10,000 subscriptions passed `RETRY_LIMIT` without being HALTED (D5's population).
- Whether non-credit plans (`credit_plan = 0`) still carry live users; if so, the C-domain
  checks must be plan-aware.
- What sets `is_credit_system_user`, which gates C6.

---

## 11. Restructure — health by lifecycle stage (proposed 2026-07-31)

The A–G domains group checks by the **table** they read (money, premium, credits,
subscription, trial, one-time, cancellation). That made them easy to write but hard to
act on: a finding says "the credit column disagrees" rather than "the post-trial debit
stage is broken".

The system should instead be organised by the **stage of the payment flow** the user is
passing through, so each group answers "did this stage do its job?".

| # | stage | what it must prove |
|---|---|---|
| 1 | **trial health** | the trial was offered, charged at ₹1, activated premium, and the window matched the configured duration |
| 2 | **post-trial first recurring health** | the first real debit after a trial fired, landed, and pinned the paid month correctly |
| 3 | **upfront payment health** | a hard-paywall repurchase cancels **every** old subscription and leaves exactly one ACTIVE |
| 4 | **recurring health** | the first recurring — the user's second full payment, whether or not they came via a trial — and every cycle after it |
| 5 | **subscriptions health** | the rail itself: state, mandate reference, next_due_at, reachability by either cron |
| 6 | **premium user health** | expiry and state transitions |
| 7 | **transaction pool health** | park and drain, single-slot collisions, undrained entries |
| 8 | **user credit health** | grant, replace semantics, exhaustion, cancellation snapshot |

Groups 1–4 are stages a user moves through in order; 5–8 are the stores those stages
write to. Most existing checks map onto one of these; the mapping is the first task when
this is picked up. Stage 3 in particular has no coverage today — nothing currently
verifies that a repurchase leaves exactly one ACTIVE subscription (D6 tests for two
ACTIVE subs but not that the supersede actually ran).

**Built 2026-07-31.** `src/stages/01-trial.js` … `08-userCredit.js`, registry in
`src/stages/index.js`, 52 checks. The A–G table-oriented checks are removed.

Three things changed beyond reorganising:

1. **`src/journey.js`** — a user's history as an ordered sequence `t, p1, p2 … pn`, one
   step per money-taking event. An anomaly always happens at a specific step, so the
   sequence is what gets modelled; each step carries its gap from the previous, whether it
   was pooled or flagged, and its settlement lag.
2. **Population filter** — every check declares its stage and is skipped for users who
   never reached it. Trial checks can no longer fire on one-time buyers, which was the
   single largest source of false positives in the first build.
3. **Entitlement in credits, not days** — `creditsGranted = grantingEvents x planCredits`
   where granting events are delivered purchases **plus the trial** (the trial charges ₹1
   but hands over the plan's full credits). Cancelling during the trial caps the balance to
   `min(10, remaining)`, which only ever reduces it, so the identity holds.

Outputs per run: `-journeys.csv` (wide, one row per user, `t/p1..pn` column groups),
`-anomalies.csv`, `-matrix.csv` (cases x cohort months), `-snapshot.csv`.
