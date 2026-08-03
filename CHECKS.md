# Payment Anomaly Detection — What We Check

Every paying user on Tarot99 and Astro99 is replayed end to end: the trial, each payment,
what the subscription did, and what the user actually received in return. 54 checks run
against that timeline, grouped by the eight stages a payment passes through.

## How to read this

**Severity**

| | meaning |
|---|---|
| **P0** | Money taken and nothing delivered, or a user billed more than they agreed to. Fix now. |
| **P1** | Entitlement is wrong — the user has less (or more) than they paid for. |
| **P2** | Billing will break soon if untouched, though nothing is wrong yet. |
| **P3** | Data is inconsistent. No user impact today. |
| **MONITOR** | Tracked and reported, but deliberately not counted as a defect. Either a known trade-off, or something we watch for trend rather than fix case by case. |

**Two kinds of check.** A *state* check reads how things stand right now, so it clears
once the data is fixed. An *event* check reads something that already happened — a debit
that landed late, two debits too close together — and a past event never stops having
happened. Event checks are therefore scoped to a rolling window (30 days by default):
older occurrences stay in the report but stop counting, so the headline number answers
*"what is breaking now"* rather than *"what has ever broken"*.

**Scope.** Razorpay (autopay + one-time) and PhonePe only. Apple and Google are excluded —
they own their own subscription lifecycle. Internal test accounts are excluded.

---

## 1. Trial health

The ₹1 mandate that starts a trial, and the ~36-hour window it buys.

| Code | Severity | What it catches |
|---|---|---|
| **T1** | MONITOR | Trial recorded at the plan price instead of ₹1. A bookkeeping mismatch — the customer was only ever charged ₹1. Fixed 12 July; kept for history. |
| **T2** | P1 | The ₹1 was collected but premium was never switched on. The user paid and got nothing. |
| **T3** | P2 | Trial charged but no subscription row exists, so there is no mandate to bill later. The trial can never convert. |
| **T4** | P3 | The same user was given more than one trial. |
| **T5** | P3 | The trial was saved as a regular payment instead of a trial, so everything downstream counts it as a full paid cycle. |
| **T6** | MONITOR | Trial given to a user outside today's eligibility range. Usually reflects an older rollout rather than a mistake. |
| **T7** | P3 | A trial that never converted is still holding premium well past the trial window. |
| **T8** | P2 | Trial converted, the mandate is chargeable and already due, but no debit was ever attempted. |

## 2. Post-trial first recurring health

The first real charge after a trial. Its expiry is pinned to the trial start, which makes
this the most fragile step in the whole flow.

| Code | Severity | What it catches |
|---|---|---|
| **PT1** | P0 | The debit landed after the date its own expiry was pinned to, so the user paid a full month and received almost none of it. |
| **PT2** | P1 | The expiry was not pinned to the trial start at all, so the cycle length is wrong. |
| **PT3** | MONITOR | The first debit took an unusually long retry chain to succeed. Not a defect by itself — it is the condition that leads to PT1. |
| **PT4** | P1 | The first debit succeeded but delivered nothing. |
| **PT5** | MONITOR | The debit was fired while the subscription was live but settled ~25-28 hours later, by which time the user had cancelled. A UPI settlement race, watched rather than treated as a defect. |

## 3. Upfront payment health

A user hitting the hard paywall and buying outright. This must replace whatever came
before it, leaving exactly one live subscription.

| Code | Severity | What it catches |
|---|---|---|
| **UP1** | P0 | Two live subscriptions were created at the same instant, so neither can see the other as newer and both will bill. Two live subscriptions on their own are fine: the debit refuses to run on any subscription that has a newer live one, so all but the newest cancel themselves when they come due. |
| **UP2** | P1 · monitor | Counts repurchases that left an older subscription still able to bill. Not a defect: the replacement deliberately leaves paused mandates alone, a paused mandate is outside the billing cron, and it only wakes when the gateway reports the user resumed it — at which point billing is what the user asked for. Reported as a rate so a sudden rise stays visible. |
| **UP3** | P0 | The money was collected and then refused on delivery, so the user paid for a window they never got. |
| **UP4** | P0 | An upfront purchase succeeded but no premium was granted at all. |
| **UP5** | MONITOR | The user bought again with plenty of their previous window left. Usually means they hit the paywall for a reason the credit balance does not explain. |
| **UP7** | P1 | A debit landed on a subscription the user had already replaced — the money went to a rail they had left. |
| **UP6** | P3 | A user whose only purchases are one-time is still carrying a live autopay mandate. |

## 4. Recurring health

Every cycle after the first. Measured on what the customer was actually charged, not on
what the schedule claims.

| Code | Severity | What it catches |
|---|---|---|
| **R1** | P0 | Two consecutive charges closer together than the plan term. A "month" that repeatedly lands at 25 days is a 22% overcharge, and it compounds. |
| **R2** | P0 | A debit was collected and delivered nothing. |
| **R3** | P2 | The retry chain made several attempts, all declined, then went silent — well short of the retry limit, so the subscription was never properly stopped either. |
| **R4** | P2 | The retry budget is spent but the subscription is still live. |
| **R5** | MONITOR | A debit took far longer than the usual T+1 to settle. |
| **R6** | MONITOR | A debit fired while the subscription was live but landed after the user cancelled. The bank usually blocks it; when it does not, we flag rather than auto-refund. |

## 5. Subscription health

The billing rail itself. A subscription is reachable by exactly two jobs — one that sets
up the next charge, one that follows up on charges already in flight. Fall outside both
and it can never be selected again, whatever its state says.

| Code | Severity | What it catches |
|---|---|---|
| **S1** | MONITOR | A live subscription with no usable mandate reference, so it can never actually be charged. |
| **S2** | P2 | A chargeable subscription whose due date has drifted outside both jobs' reach. It will never be picked up again. |
| **S3** | P0 | The next charge is scheduled *before* the period the user already paid for ends — an early charge. This is the root many other findings derive from. The report also records whether the pooling slot is free, which decides whether the early charge self-corrects or is lost. |
| **S4** | P3 | The due date has drifted more than a full cycle past expiry. |
| **S5** | P2 | A chargeable subscription that has never been billed at all. |
| **S6** | P3 | A live subscription with no premium record behind it. |
| **S7** | MONITOR | A cancelled or stopped subscription still carrying a future due date. Untidy, but it cannot produce a charge. |

## 6. Premium user health

What the user is actually entitled to right now.

| Code | Severity | What it catches |
|---|---|---|
| **PU1** | P3 | Marked active although the expiry passed over a day ago. |
| **PU2** | P1 | Marked expired although the expiry is still in the future — access removed early. |
| **PU3** | P3 | Marked active with a missing or zero expiry date, so it can never expire. |
| **PU4** | P3 | An expiry set implausibly far into the future. |
| **PU5** | P3 | Premium active with no plan attached. |
| **PU6** | P2 | Premium granted with no payment behind it. |
| **PU7** | P1 | The expiry moved *backwards* since the previous scan — a user lost time they had already been given. |

## 7. Transaction pool health

When a charge succeeds while the user still has time left, the cycle is parked in a
"pool" and applied when the current one runs out. The pool holds **one** entry at a time.

| Code | Severity | What it catches |
|---|---|---|
| **TP1** | P0 | Two or more entries parked at once — the single slot was violated. |
| **TP2** | P0 | An entry still parked although premium has already lapsed. The money was collected and the cycle never delivered. |
| **TP3** | P0 | A charge was marked as pooled but never reached the pool. |
| **TP4** | P1 | A charge collided with a cycle already parked, so it was flagged: money taken, nothing delivered. |
| **TP5** | MONITOR | An entry sitting unusually long while premium is still running. |

## 8. User credit health

Plans are dual-limit — *N messages or N days, whichever ends first* — so entitlement is
measured in credits, not only in dates.

| Code | Severity | What it catches |
|---|---|---|
| **UC1** | P1 | The user consumed more credits than were ever granted to them. |
| **UC2** | P1 | Used exceeds the total on the current balance. |
| **UC3** | P1 | Premium is active but no credits were granted, so there is nothing to spend. |
| **UC4** | P1 | Premium is active with the balance already exhausted. |
| **UC5** | P3 | The balance is larger than the plan grants. |
| **UC6** | P1 | The balance dropped with no purchase or usage to explain it. |
| **UC7** | P1 | Credits disagree with what the cancellation recorded. |
| **UC9** | P0 | The trial-cancellation credit cap was applied to a user who had already paid in full. |
| **UC8** | P3 | The user is on a credit plan but is not marked as a credit-system user. |

---

## What this does not cover

Stated plainly, so the report is not read as broader than it is.

- **Apple and Google** subscriptions are out of scope entirely.
- **Refunds and chargebacks** are not modelled. A refunded payment still reads as collected.
- **Gateway-side truth** is not fetched during a scan. Everything is derived from our own
  records; where a gateway's answer mattered we have checked it by hand, case by case.
- **Recently created cohorts cannot exercise the recurring checks.** A user who has not
  reached their second billing cycle cannot produce an R1 or a TP4, so a clean result on a
  two-week-old cohort means "nothing wrong yet", not "nothing will go wrong".
