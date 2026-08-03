import { GATEWAYS_EXCLUDED, TEST_PHONE_PATTERN, TEST_PHONES } from '../config/products.js'

// The scan population is every user with a payment footprint: a row in transaction,
// premium_user, or payment_subscription. Users with no footprint at all cannot break
// any payment invariant, so scanning them would only cost time.
//
// Users holding an Apple or Google subscription are excluded here, at the user level.
// The store drives their premium_user state, so our expiry and credit invariants do
// not apply to them even for their Razorpay/PhonePe rows.
export async function selectCohort (pool, { createdFrom, createdTo, limit }) {
  const excluded = GATEWAYS_EXCLUDED.map(() => '?').join(',')
  const testPhones = TEST_PHONES.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT u.user_id, u.bucket, u.createdAt, u.is_credit_system_user, u.country_id, u.state AS user_state
       FROM user u
      WHERE u.createdAt >= ? AND u.createdAt < ?
        -- Internal test accounts. They are driven by hand through arbitrary payment
        -- states, so every invariant here is meaningless for them.
        AND CAST(u.phone AS CHAR) NOT LIKE ?
        AND CAST(u.phone AS CHAR) NOT IN (${testPhones})
        AND (
              EXISTS (SELECT 1 FROM payment_subscription ps WHERE ps.user_id = u.user_id)
           OR EXISTS (SELECT 1 FROM premium_user pu       WHERE pu.user_id = u.user_id)
           OR EXISTS (SELECT 1 FROM transaction t         WHERE t.user_id  = u.user_id)
            )
        AND NOT EXISTS (
              SELECT 1 FROM payment_subscription ps2
               WHERE ps2.user_id = u.user_id AND ps2.gateway IN (${excluded})
            )
      ORDER BY u.user_id
      ${limit ? 'LIMIT ?' : ''}`,
    limit
      ? [createdFrom, createdTo, `%${TEST_PHONE_PATTERN}%`, ...TEST_PHONES, ...GATEWAYS_EXCLUDED, limit]
      : [createdFrom, createdTo, `%${TEST_PHONE_PATTERN}%`, ...TEST_PHONES, ...GATEWAYS_EXCLUDED]
  )
  return rows
}

// Loads every payment-related row for one slice of users. Five separate queries keyed
// on user_id beat a single join: the join would multiply transaction rows by
// subscription rows and force the caller to de-duplicate.
export async function fetchSlice (pool, userIds) {
  if (userIds.length === 0) return { premium: [], credits: [], subs: [], txns: [], pool: [], creditUsage: [] }
  const ph = userIds.map(() => '?').join(',')
  const q = (sql) => pool.query(sql, userIds).then(([rows]) => rows)

  // Six independent reads, issued together rather than one after another. They were
  // sequential and the slowest of them (transaction) is an order of magnitude bigger than
  // the rest, so five connections sat idle for most of every chunk. The pool is sized to
  // hold all six plus the next chunk's prefetch.
  const [premium, credits, subs, txns, poolRows, creditUsage] = await Promise.all([
    q(`SELECT user_id, state, premium_plan_id, expireAt, source, is_trial, createdAt, updatedAt
         FROM premium_user WHERE user_id IN (${ph})`),

    q(`SELECT user_id, total, used, updatedAt
         FROM user_credit WHERE user_id IN (${ph})`),

    q(`SELECT id, user_id, subscription_id, gateway, subscription_type, state,
              premium_plan_id, next_due_at, metadata, created_at, updated_at
         FROM payment_subscription WHERE user_id IN (${ph})`),

    q(`SELECT id, user_id, subscription_id, gateway, state, amount, premium_plan_id,
              metadata, createdAt, success_at
         FROM transaction WHERE user_id IN (${ph}) ORDER BY user_id, id`),

    q(`SELECT id, user_id, payment_transaction_id, premium_plan_id, subscription_id,
              state, added_at, used_at, metadata
         FROM transaction_pool WHERE user_id IN (${ph})`),

    // Credit consumption is the only part of entitlement with real history — user_credit
    // and premium_user are both overwritten in place, but user_credit_usage keeps every
    // deduction with its timestamp. Aggregated in SQL because the raw rows carry user
    // message text and run to millions.
    q(`SELECT user_id, COUNT(*) events, SUM(credits_deducted) consumed,
              MIN(createdAt) first_used, MAX(createdAt) last_used
         FROM user_credit_usage WHERE user_id IN (${ph}) GROUP BY user_id`)
  ])

  return { premium, credits, subs, txns, pool: poolRows, creditUsage }
}

// premium_plan is small and fully cacheable, so it is loaded once per run rather than
// joined per slice. credits come from metadata.creditsIncluded; there is no column.
export async function loadPlans (pool) {
  const [rows] = await pool.query(
    'SELECT id, term, amount, credit_plan, start_bucket, end_bucket, state, metadata FROM premium_plan')
  const byId = new Map()
  for (const r of rows) {
    let meta = {}
    try { meta = r.metadata ? JSON.parse(r.metadata) : {} } catch { meta = {} }
    byId.set(r.id, {
      id: r.id,
      term: r.term,
      amount: r.amount,
      isCreditPlan: r.credit_plan === 1,
      credits: Number(meta.creditsIncluded) || 0,
      allowTrial: meta.allowTrial === true,
      startBucket: r.start_bucket,
      endBucket: r.end_bucket,
      state: r.state
    })
  }
  return byId
}
