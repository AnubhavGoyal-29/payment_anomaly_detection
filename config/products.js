// Per-product configuration. Credentials are read from each product's own env.sh at
// runtime (see src/db.js) rather than being duplicated here.

// Three values, not two. RAZORPAY_OD carries mandates (trials, mandate setup, recurring
// debits); plain RAZORPAY carries one-time purchases, which create no subscription row —
// which is why it never appears in payment_subscription and was missed at first. Omitting
// it hid 28,728 successful one-time payments (₹39.7L since 1 June) from every check.
export const GATEWAYS_IN_SCOPE = ['RAZORPAY_OD', 'RAZORPAY', 'PHONEPE']

// Users holding any subscription on these gateways are dropped from the scan entirely.
// The store owns their premium lifecycle, so our expiry and credit invariants would
// false-fire on them. Filtering on the transaction's gateway alone is not sufficient.
export const GATEWAYS_EXCLUDED = ['APPLE_IAPS', 'GOOGLE_PLAY']

export const TERM_DAYS = {
  WEEKLY: 7,
  MONTHLY: 30,
  QUARTERLY: 90,
  YEARLY: 365
}

// razorpay.js RETRY_LIMIT, term-dependent.
export const RETRY_LIMIT = {
  WEEKLY: 6,
  MONTHLY: 16,
  QUARTERLY: 16,
  YEARLY: 16
}

export const TRIAL = {
  MANDATE_AMOUNT: 1,
  DURATION_HOURS: 36,
  BUCKET_MIN: 0,
  BUCKET_MAX: 94
}

// The recurring-debit init cron selects next_due_at in [IST-midnight(now+4d),
// IST-midnight(now+5d)). The window only moves forward, so a subscription whose
// next_due_at falls below the 4-day floor is never selectable again.
export const INIT_CRON = {
  LEAD_DAYS_MIN: 4,
  LEAD_DAYS_MAX: 5
}

// Every flagReason observed in production. A flagged transaction is money collected
// while the delivery path deliberately did nothing.
export const FLAG_REASONS = [
  'duplicate_pool_same_subscription',
  'subscription_not_active',
  'one_time_user_already_premium'
]

// Internal test accounts. Driven by hand through arbitrary payment states, so every
// invariant here is meaningless for them. Most carry 111111 in the phone number; these
// two do not, and each produced a convincing false finding before being identified —
// a year of premium for a ₹299 monthly plan, and premium held on a payment still PENDING.
// Add to this list rather than filtering after the fact.
export const TEST_PHONE_PATTERN = '111111'
export const TEST_PHONES = ['919380419838', '918423829911']

// T7's historical population is closed and fully explained, so the check is floored to
// users created on or after these dates and reads as a tripwire rather than an archive.
//
// Both products stop on the same day. Trials that ended up holding premium far past the
// 36-hour window ran 8 May - 26 June on tarot (12,414, tapering to nine on the last day)
// and 11 May - 26 June on astro (3,715), and every one of them is the footprint of our own
// 31 July remediation, which granted premium to users whose is_trial flag had never been
// cleared. Whatever stuck those subscriptions ended on 26 June.
//
// Above the floor tarot reads zero. Astro reads one — user 9003314810, trial 21 July, given
// a full month on a ₹1 mandate with no bulk write anywhere near it. That is a real leak and
// exactly what the floor is meant to leave visible.
export const T7_COHORT_FLOOR = {
  tarot: '2026-06-27T00:00:00Z',
  astro: '2026-06-27T00:00:00Z'
}

// UC1's population is closed and narrow. Consuming more credits than were ever granted
// happened to 77 tarot users created between 23 and 28 April, one straggler on 27 May, and
// nobody since — 9,792 credits in total. On astro it never happened at all. Flooring the
// check to users created after the last occurrence turns it into a tripwire: it reads zero
// from here, and anything above zero is new rather than six-day-old history.
export const UC1_COHORT_FLOOR = {
  tarot: '2026-05-28T00:00:00Z',
  astro: '2026-05-28T00:00:00Z'
}

// The floor the backend applies when a payment lands with little or no period left
// (POST_TRIAL_EXPIRY_FLOOR_DAYS in razorpay.js, live on the release branch). A grant at or
// above this is the floor working; below it means the user paid and got nothing.
export const EXPIRY_FLOOR_DAYS = 7

// The premium_user checks (PU2, PU3, PU4, PU6) all read the same closed population: rows
// written before the payment flow was tightened, where premium was granted while every
// transaction behind it was still PENDING. Seventeen of them survive across both products,
// on legacy plan 1 and 5, premium rows created between June 2025 and 22 June 2026 — expiry
// dates of 2029, 2030, 2036, two of 2070, and one literal '2050-00-00 00:00:00', which is
// not a date at all. Nothing new has joined them.
//
// They are real users, several still active, so the entitlement stands as a product
// decision rather than a defect to correct. Flooring these checks to premium rows created
// on or after this date turns them into tripwires: zero from here, and anything above zero
// is a new grant with no payment behind it. Floored on the premium row's own createdAt,
// not the user's — the user may long predate the grant.
export const PREMIUM_GRANT_FLOOR = {
  tarot: '2026-06-23T00:00:00Z',
  astro: '2026-06-23T00:00:00Z'
}

// A ghost is someone paying for premium and not using it: entitlement live, no message
// sent in this many days. Reported as a rate rather than a defect — nothing is broken, it
// is a churn signal that tends to precede a cancellation or a chargeback.
export const GHOST_SILENT_DAYS = 15

export const TXN_TYPES = ['TRIAL_SETUP', 'MANDATE_SETUP', 'RECURRING_DEBIT', 'ONE_TIME']

// Transaction states that represent money actually collected.
export const PAID_STATES = ['SUCCESS', 'TRIAL_SUCCESS']

// Transaction types that buy a full billing cycle. TRIAL_SETUP buys only the trial
// window, so it anchors the timeline without contributing a cycle.
export const CYCLE_TXN_TYPES = ['MANDATE_SETUP', 'RECURRING_DEBIT']

// Amplitude keys are NOT here — they live in config/credentials.json alongside the
// database credentials, which is gitignored. Nothing in this file may be a secret: it is
// the one config file that ships with the repo.
export const PRODUCTS = {
  tarot: {
    key: 'tarot',
    label: 'tarot99',
    envFile: '/Users/crafto/tarrot99-backend/env.sh'
  },
  astro: {
    key: 'astro',
    label: 'astro99',
    envFile: '/Users/crafto/livo-backend/env.sh',
    // livo's env.sh names the database 'livo'; the astro99 product actually lives in
    // the astro99 schema on the same host, so the env value must be overridden.
    database: 'astro99'
  }
}
