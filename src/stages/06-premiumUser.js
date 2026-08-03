import { days, iso, isPremiumNow } from './util.js'
import { GHOST_SILENT_DAYS } from '../../config/products.js'

// Stage 6 — premium_user. The central trap: expireAt means two different things. On an
// ACTIVE row it is the end of the paid period; the moment premium expires, both the lazy
// path (premiumUser.js) and the hourly cron (expireActivePremiumUser) overwrite it with
// `new Date()`. That is a deliberate "moment of first flip" audit semantic, not a bug —
// but it means an EXPIRED row's expireAt records when the cron arrived, not when the
// entitlement ended, and for a large backlog that can be weeks late.

export default [
  {
    code: 'PU1',
    severity: 'P3',
    title: 'ACTIVE but expired over a day ago',
    // The expiry cron runs hourly with a 24h buffer, so anything older should be flipped.
    fn: (l) => {
      if (l.premium?.state !== 'ACTIVE') return null
      if (l.actualExpiryMs === null || l.actualExpiryMs >= l.nowMs - 86400000) return null
      return {
        expiredAt: iso(l.actualExpiryMs),
        staleDays: days(l.nowMs - l.actualExpiryMs),
        hasPoolEntry: l.addedPool.length > 0
      }
    }
  },
  {
    code: 'PU2',
    severity: 'P1',
    title: 'EXPIRED while the expiry date is still in the future',
    fn: (l) => {
      if (l.premium?.state !== 'EXPIRED') return null
      if (l.actualExpiryMs === null || l.actualExpiryMs <= l.nowMs) return null
      return { expireAt: iso(l.actualExpiryMs), daysRemaining: days(l.actualExpiryMs - l.nowMs) }
    }
  },
  {
    code: 'PU3',
    severity: 'P3',
    title: 'ACTIVE with a null or zero expiry date',
    fn: (l) => {
      if (l.premium?.state !== 'ACTIVE' || l.actualExpiryMs !== null) return null
      return { expireAtRaw: String(l.premium.expireAtRaw ?? '(null)') }
    }
  },
  {
    code: 'PU4',
    severity: 'P3',
    title: 'Expiry absurdly far in the future',
    fn: (l, j) => {
      if (l.actualExpiryMs === null) return null
      const ahead = days(l.actualExpiryMs - l.nowMs)
      if (ahead <= 400) return null
      return { expireAt: iso(l.actualExpiryMs), daysAhead: ahead, purchases: j.stepCount }
    }
  },
  {
    code: 'PU5',
    severity: 'P3',
    title: 'ACTIVE with no plan attached',
    fn: (l) => {
      if (l.premium?.state !== 'ACTIVE' || l.premium.planId) return null
      return { source: l.premium.source, expireAt: iso(l.actualExpiryMs) }
    }
  },
  {
    code: 'PU6',
    severity: 'P2',
    title: 'Premium granted with no payment behind it',
    // Scoped to a live window. A user who paid on a gateway outside scope, or who was
    // granted premium by a promo, would otherwise read as an anomaly forever.
    fn: (l, j) => {
      if (l.premium?.state !== 'ACTIVE') return null
      if (l.actualExpiryMs === null || l.actualExpiryMs <= l.nowMs) return null
      if (j.stepCount > 0 || j.hadTrial) return null
      return { source: l.premium.source, expireAt: iso(l.actualExpiryMs), planId: l.premium.planId }
    }
  },
  {
    code: 'PU7',
    severity: 'P1',
    title: 'Expiry moved backwards since the last scan',
    needsPrev: true,
    fn: (l, j, prev) => {
      if (!prev || prev.actualExpiryMs === null || l.actualExpiryMs === null) return null
      const lost = days(prev.actualExpiryMs - l.actualExpiryMs)
      if (lost < 1) return null
      // A new purchase legitimately rewrites the expiry, as does the flip semantic above.
      if (j.stepCount > (prev.paidCycles ?? 0)) return null
      if (prev.premiumState === 'ACTIVE' && l.premium?.state !== 'ACTIVE') return null
      return { lostDays: lost, previousExpiry: iso(prev.actualExpiryMs), currentExpiry: iso(l.actualExpiryMs) }
    }
  },
  {
    code: 'PU8',
    severity: 'P3',
    // Not a defect — a rate to watch, so track-only. Restricted to credit-system users
    // because user_credit_usage is the only per-message record in MySQL (the chat itself
    // lives in Firestore), and a user outside that system has no rows there at all and
    // would read as silent no matter how much they were using the product.
    //
    // Silence is measured from the last message where there is one, and from the start of
    // the current entitlement where there is none — otherwise everyone who paid this
    // morning and has not opened the app yet would count as a ghost on day one.
    track: true,
    title: 'Ghost user — premium live but no message in the silent window',
    fn: (l) => {
      if (!l.isCreditSystemUser) return null
      if (!isPremiumNow(l)) return null
      const lastUsedMs = l.creditUsage?.lastUsedMs ?? null
      // Fall back to when this entitlement was last written, so a fresh purchase is not
      // called a ghost before the user has had the window to use it.
      const sinceMs = lastUsedMs ?? l.premium?.updatedAtMs ?? null
      if (sinceMs === null) return null
      const silentDays = days(l.nowMs - sinceMs)
      if (silentDays < GHOST_SILENT_DAYS) return null
      return {
        silentDays,
        lastMessageAt: iso(lastUsedMs),
        everMessaged: lastUsedMs !== null,
        messagesEver: l.creditUsage?.events ?? 0,
        creditsLeft: l.credit ? Math.max(0, (l.credit.total || 0) - (l.credit.used || 0)) : null,
        expiry: iso(l.actualExpiryMs)
      }
    }
  }
]
