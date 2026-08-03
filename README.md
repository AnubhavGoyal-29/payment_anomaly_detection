# payment_anomaly_detection

Replays every paying user of Tarot99 and Astro99 end to end — the trial, each payment, what
the subscription did, and what the user actually received — and reports where those disagree.

Read-only by construction: the whole project issues SELECT statements and has no write path.

## Running

```bash
node src/run.js --product=tarot --from=2026-05-01 --to=2026-08-04
```

| flag | meaning |
|---|---|
| `--product` | `tarot` or `astro` |
| `--from` / `--to` | cohort bounds on `user.createdAt` (required) |
| `--since` | event-check window in days, default `30`; `0` disables it |
| `--limit` | cap the population, for a quick pass |
| `--chunk` | users per batch, default `4000` |
| `--snapshot-in` | a previous run's snapshot CSV, needed by the delta checks |

Four CSVs land in `output/`: `anomalies`, `journeys` (`t, p1…pn` per user), `matrix`
(cases × months) and `snapshot`.

## Running it daily

```bash
node src/run.js   --product=tarot --from=2025-01-01 --to=2026-08-05   # the scan, ~26 min
node src/daily.js --product=tarot                                     # the report, instant
```

`daily.js` finds the newest anomalies CSV for that product, records which users each check
is holding under `output/daily/`, and compares that against the previous day's record.

**It compares user IDs, not counts, and that distinction is the whole point.** Every state
check empties as its findings are repaired, so its number falls whether or not anything new
broke — and a number that moved from 14 to 1 can still be hiding a new user. On a live test
it did exactly that: S3 dropped by thirteen while gaining one, and UC9 read "+2" by count
when three users were actually new. So the report leads with `today \ yesterday` and treats
the count as context.

| section | meaning |
|---|---|
| `NEW` | users a check is holding that it was not holding yesterday — the alert |
| `RESOLVED` | users it lost; informational, and flagged loudly if a check empties outright, which is more often a broken check than a fixed population |
| `RATES` | track-only checks as a percentage — never an alert |

A run whose matrix CSV is missing is refused: that means the scan was interrupted, and a
partial population would report every unscanned user as resolved.

## Configuration

`config/credentials.json` is gitignored and holds everything secret:

```json
{
  "tarot": { "host": "…", "port": 3306, "user": "…", "password": "…",
             "database": "tarrot99", "amplitudeApiKey": "…" },
  "astro": { "…": "…", "database": "astro99" }
}
```

`config/products.js` holds the rest, and nothing in it may be a secret — it is the one
config file that ships with the repo.

## What it checks

55 checks across the eight stages a payment passes through. `CHECKS.md` documents every one
in plain language, with the severity scale and what the system deliberately does not cover.

## Two things worth knowing before reading a report

**State checks clear themselves; event checks never do.** A state check reads how things
stand now, so fixing the data silences it. An event check reads something that already
happened — a debit that landed late, two debits too close together — and a past event never
stops having happened. Event checks are therefore scoped to `--since`, so the headline
answers *what is breaking now* rather than *what has ever broken*. Without that window, one
long-fixed bug reported 193,560 users and drowned everything else.

**A remediation leaves a footprint that looks exactly like a defect.** Bulk-granting premium
or credits to settle a past problem makes those users fail the very invariants that found
them. Before treating a spike as real, intersect the flagged user IDs against whatever
scripts have been run. On one full scan, 25,211 of 25,927 flagged users were the trace of
our own writes.
