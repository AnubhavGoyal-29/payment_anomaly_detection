export const DAY_MS = 86400000
export const HOUR_MS = 3600000

export const days = ms => Math.round(ms / DAY_MS)
export const iso = ms => (ms === null || ms === undefined) ? null : new Date(ms).toISOString()

// The init cron's selection window is computed from IST midnight, not from the current
// instant: it selects next_due_at in [istMidnight(now+4d), istMidnight(now+5d)). Using a
// rolling now+4d instead puts the floor up to a day late and calls subscriptions dead that
// today's run can still pick up. Mirrors the backend (phonepe.js, handlePhonepeSubscriptionActive).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000
export const istMidnightUtcMs = ms =>
  Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS

// Below this, the init cron can never select the subscription again — the window only
// moves forward, so a due date under the floor is out of reach whether or not it has passed.
export const initWindowFloorMs = (nowMs, leadDaysMin) =>
  istMidnightUtcMs(nowMs + leadDaysMin * DAY_MS)

// premium_user.state cannot be trusted alone. The ACTIVE -> EXPIRED flip is driven by an
// hourly cron with a 24h buffer (and, before that, only by the user opening the app), so a
// row can read ACTIVE with an expiry well in the past.
export const isPremiumNow = l =>
  !!l.premium && l.premium.state === 'ACTIVE' &&
  l.actualExpiryMs !== null && l.actualExpiryMs > l.nowMs

// State alone. Only the mandate-reference check should use this.
export const isSubStateLive = s => !!s && ['ACTIVE', 'GRACE_PERIOD'].includes(s.state)

// Live AND chargeable. mandateRef is gateway-aware because PhonePe has no token field —
// it identifies the mandate by merchantSubscriptionId — so testing metadata.token
// directly would silently drop every PhonePe user from every check.
export const isSubLive = s => isSubStateLive(s) && !!s.mandateRef

// expireAt means two different things. On an ACTIVE row it is the end of the paid period;
// the moment premium expires both the lazy path and the hourly cron overwrite it with the
// flip time. Any check comparing expiry against a payment timeline must guard on this.
export const hasMeaningfulExpiry = l => l.premium?.state === 'ACTIVE'
