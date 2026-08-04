// Builds the day's findings into one page, read on screen and saved as a PDF from the
// browser. Exported so daily.js can regenerate it at the end of every run.
//
// The page is built around the one thing this whole system exists to say: a count cannot
// answer the question. A state check empties as its findings are repaired, so its number
// falls whether or not anything new broke — 14 down to 1 can still be hiding a new user.
// Only identity answers it. So the evidence here is the set of user IDs a check is holding
// that it was not holding yesterday, and the report is laid out to put those IDs on the
// page rather than a headline figure.
//
//   RED    checks holding someone new. Set difference on user IDs.
//   BLUE   track-only checks whose rate rose. These never flag, so a count is the right
//          unit and a rise is worth a look, not an alarm.
//   LEDGER today and yesterday in full, so the two sections above can be checked rather
//          than taken on trust.
//
// Severity orders everything, never count: a P0 holding one user matters more than a P3
// holding twelve thousand, and sorting by size buries the thing worth reading.
//
//   node src/report.js
//   node src/report.js --date=2026-08-04 --products=tarot

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_CHECKS } from './stages/index.js'

const OUT_DIR = new URL('../output/', import.meta.url).pathname
const STATE_DIR = join(OUT_DIR, 'daily')
const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = n => Number(n ?? 0).toLocaleString('en-IN')

function statesFor (product) {
  if (!existsSync(STATE_DIR)) return []
  return readdirSync(STATE_DIR)
    .filter(f => f.startsWith(`${product}-`) && f.endsWith('-state.json'))
    .sort()
    .map(f => JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')))
}

// A check gained someone it was not holding before. Set difference, never arithmetic.
function gains (product, today, prev) {
  const out = []
  for (const c of ALL_CHECKS) {
    if (c.track === true) continue
    const now = new Set(today.checks?.[c.code]?.ids || [])
    const then = new Set(prev?.checks?.[c.code]?.ids || [])
    const fresh = [...now].filter(id => !then.has(id))
    if (fresh.length) out.push({ product, code: c.code, severity: c.severity, title: c.title, ids: fresh, before: then.size, after: now.size })
  }
  return out.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (b.ids.length - a.ids.length))
}

function rises (product, today, prev) {
  const out = []
  for (const c of ALL_CHECKS) {
    if (c.track !== true) continue
    const now = today.checks?.[c.code]?.count ?? 0
    const then = prev?.checks?.[c.code]?.count
    if (then === undefined || now <= then) continue
    out.push({ product, code: c.code, title: c.title, now, delta: now - then, pct: today.scanned ? (now / today.scanned) * 100 : null })
  }
  return out.sort((a, b) => b.delta - a.delta)
}

function ledger (state) {
  const rows = ALL_CHECKS
    .map(c => ({ c, n: state?.checks?.[c.code]?.count ?? 0 }))
    .filter(x => x.n > 0)
    .sort((a, b) => (SEV_ORDER[a.c.severity] - SEV_ORDER[b.c.severity]) || (b.n - a.n))
  if (!rows.length) return '<p class="quiet">kuch nahi</p>'
  return `<table class="led"><tbody>${rows.map(({ c, n }) => `<tr${c.track ? ' class="t"' : ''}>
    <td class="s ${c.severity}">${c.severity}</td><td class="c">${esc(c.code)}</td>
    <td class="n">${num(n)}</td><td class="d">${esc(c.title)}${c.track ? '<i>rate</i>' : ''}</td></tr>`).join('')}</tbody></table>`
}

export function buildReport ({ products = ['tarot', 'astro'], date = null } = {}) {
  const days = []
  for (const product of products) {
    const all = statesFor(product)
    if (!all.length) continue
    const today = date ? all.find(s => s.date === date) : all.at(-1)
    if (!today) continue
    const prior = all.filter(s => s.date < today.date)
    days.push({ product, today, prev: prior.length ? prior.at(-1) : null })
  }
  if (!days.length) return null

  const allGains = days.flatMap(d => gains(d.product, d.today, d.prev))
  const allRises = days.flatMap(d => rises(d.product, d.today, d.prev))
  const reportDate = days[0].today.date
  const prevDate = days[0].prev?.date ?? null
  const newUsers = allGains.reduce((s, g) => s + g.ids.length, 0)

  const verdict = !prevDate
    ? 'Pehla din. Aaj kiske paas kaun hai, wo darj kar liya — tulna kal se shuru.'
    : allGains.length === 0
      ? 'Koi check aisa user nahi pakde hue hai jo kal nahi tha.'
      : `${allGains.length} check aise user pakde hue hain jo kal nahi the.`

  const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment anomalies · ${esc(reportDate)}</title>
<style>
:root{
  --paper:#fbfbfc; --ink:#17171b; --quiet:#75757f; --rule:#e2e2e7; --faint:#f2f2f5;
  --red:#a32014; --blue:#234c9b;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{
  margin:0;padding:44px 40px 80px;max-width:1080px;background:var(--paper);color:var(--ink);
  font:13px/1.6 var(--mono);font-variant-ligatures:none;
}

/* masthead — the verdict is the hero, not a number */
.mast{border-bottom:2px solid var(--ink);padding-bottom:14px}
.kick{display:flex;justify-content:space-between;align-items:baseline;gap:16px;
  font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--quiet)}
.verdict{font:500 27px/1.28 -apple-system,"Helvetica Neue",Inter,system-ui,sans-serif;
  letter-spacing:-.022em;margin:16px 0 14px;max-width:24ch}
.verdict b{color:var(--red);font-weight:600}
.scan{display:flex;gap:26px;flex-wrap:wrap;font-size:12px;color:var(--quiet)}
.scan b{color:var(--ink);font-weight:600}

/* section headings */
h2{font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin:40px 0 3px;
  display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;height:1px;background:var(--rule)}
h2.r{color:var(--red)} h2.b{color:var(--blue)}
.lede{color:var(--quiet);font-size:12px;margin:0 0 18px;max-width:76ch}

/* findings — severity is the structural marker, IDs are the evidence */
.find{display:grid;grid-template-columns:34px 1fr;border-top:1px solid var(--rule);
  padding:14px 0 15px;break-inside:avoid}
.find:last-child{border-bottom:1px solid var(--rule)}
.rail{font-size:11px;font-weight:700;letter-spacing:.04em;padding-top:2px}
.rail.P0{color:var(--red)} .rail.P1{color:#b4560c} .rail.P2{color:#3f4652} .rail.P3{color:var(--quiet)}
.hd{display:flex;align-items:baseline;gap:11px;flex-wrap:wrap}
.code{font-size:15px;font-weight:700;letter-spacing:-.01em}
.prod{font-size:11px;color:var(--quiet);letter-spacing:.1em;text-transform:uppercase}
.plus{margin-left:auto;font-size:15px;font-weight:700;color:var(--red)}
.was{font-size:11px;color:var(--quiet)}
.what{font:13px/1.5 -apple-system,"Helvetica Neue",Inter,system-ui,sans-serif;
  color:#33333c;margin:5px 0 0;max-width:80ch}
.ev{margin-top:9px;padding:9px 11px;background:var(--faint);border-left:2px solid var(--red);
  font-size:11.5px;line-height:1.9;color:#4a4a55;word-break:break-all}
.ev span{margin-right:12px;white-space:nowrap}
.ev em{font-style:normal;color:var(--quiet)}

/* rates */
table{width:100%;border-collapse:collapse}
.rates td{padding:7px 10px 7px 0;border-top:1px solid var(--rule);font-size:12.5px}
.rates tr:last-child td{border-bottom:1px solid var(--rule)}
.rates .c{font-weight:700;width:56px}
.rates .p{color:var(--quiet);font-size:11px;letter-spacing:.1em;text-transform:uppercase;width:70px}
.rates .n,.rates .g,.rates .pc{text-align:right;font-variant-numeric:tabular-nums}
.rates .g{color:var(--blue);font-weight:700;width:82px}
.rates .n{width:88px} .rates .pc{color:var(--quiet);width:66px}
.rates .d{font:12.5px/1.45 -apple-system,"Helvetica Neue",Inter,system-ui,sans-serif;color:#33333c;padding-left:14px}

/* ledger */
.cols{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:6px}
.col h3{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--quiet);
  margin:0 0 6px;padding-bottom:5px;border-bottom:1px solid var(--rule)}
.led td{padding:4.5px 6px 4.5px 0;font-size:12px;border-bottom:1px solid var(--faint)}
.led .s{width:26px;font-size:10px;font-weight:700}
.led .s.P0{color:var(--red)} .led .s.P1{color:#b4560c} .led .s.P2{color:#3f4652} .led .s.P3{color:#b0b0ba}
.led .c{width:48px;font-weight:700}
.led .n{width:66px;text-align:right;font-variant-numeric:tabular-nums}
.led .d{font:11.5px/1.4 -apple-system,"Helvetica Neue",Inter,system-ui,sans-serif;color:#4a4a55;padding-left:12px}
.led tr.t td{color:var(--quiet)}
.led .d i{font-style:normal;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--quiet);border:1px solid var(--rule);padding:1px 4px;margin-left:7px;border-radius:2px}
.prodhead{font-size:12px;letter-spacing:.2em;text-transform:uppercase;margin:36px 0 10px;
  padding-bottom:6px;border-bottom:1px solid var(--ink);font-weight:700}

.none{padding:15px 0;color:var(--quiet);border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.quiet{color:var(--quiet)}
footer{margin-top:44px;padding-top:12px;border-top:1px solid var(--rule);
  color:var(--quiet);font-size:11px;line-height:1.7}

@media (max-width:720px){
  body{padding:26px 18px 50px}
  .cols{grid-template-columns:1fr;gap:22px}
  .verdict{font-size:21px}
  .rates .d{display:none}
}
@media print{
  body{padding:0;max-width:none;font-size:10.5px;background:#fff}
  .verdict{font-size:20px} h2{margin-top:22px}
  .find,.col,tr{break-inside:avoid}
  footer{break-before:avoid}
}
@page{margin:13mm}
</style>

<div class="mast">
  <div class="kick"><span>Payment anomalies</span><span>${esc(reportDate)}${prevDate ? ` &larr; ${esc(prevDate)}` : ''}</span></div>
  <p class="verdict">${allGains.length ? `<b>${esc(verdict)}</b>` : esc(verdict)}</p>
  <div class="scan">${days.map(d => `<span>${esc(d.product)} <b>${num(d.today.scanned)}</b> scanned</span>`).join('')}${allGains.length ? `<span><b>${num(newUsers)}</b> naye users</span>` : ''}</div>
</div>

<h2 class="r">Naya</h2>
<p class="lede">Wo checks jo aisa user pakde hue hain jo kal nahi tha. Milaan user ID se hota hai, count se nahi — count gir kar bhi naya user chhupa sakta hai.</p>
${allGains.length === 0
  ? '<div class="none">Kuch naya nahi.</div>'
  : allGains.map(g => `<div class="find">
      <div class="rail ${g.severity}">${g.severity}</div>
      <div>
        <div class="hd"><span class="code">${esc(g.code)}</span><span class="prod">${esc(g.product)}</span>
          <span class="was">${num(g.before)} &rarr; ${num(g.after)}</span>
          <span class="plus">+${num(g.ids.length)}</span></div>
        <p class="what">${esc(g.title)}</p>
        <div class="ev">${g.ids.slice(0, 40).map(id => `<span>${esc(id)}</span>`).join('')}${g.ids.length > 40 ? `<em>+${num(g.ids.length - 40)} aur</em>` : ''}</div>
      </div></div>`).join('')}

<h2 class="b">Rates</h2>
<p class="lede">Track-only checks jinka number badha. Ye kabhi flag nahi hote — kharabi nahi, rujhaan hain.</p>
${allRises.length === 0
  ? '<div class="none">Kisi rate me badhotri nahi.</div>'
  : `<table class="rates"><tbody>${allRises.map(t => `<tr>
      <td class="c">${esc(t.code)}</td><td class="p">${esc(t.product)}</td>
      <td class="n">${num(t.now)}</td><td class="g">+${num(t.delta)}</td>
      <td class="pc">${t.pct === null ? '&mdash;' : t.pct.toFixed(2) + '%'}</td>
      <td class="d">${esc(t.title)}</td></tr>`).join('')}</tbody></table>`}

${days.map(d => `<div class="prodhead">${esc(d.product)}</div>
  <div class="cols">
    <div class="col"><h3>Aaj &middot; ${esc(d.today.date)}</h3>${ledger(d.today)}</div>
    <div class="col"><h3>${d.prev ? 'Kal &middot; ' + esc(d.prev.date) : 'Kal'}</h3>${d.prev ? ledger(d.prev) : '<p class="quiet">pichhla din nahi hai</p>'}</div>
  </div>`).join('')}

<footer>
  Severity ke hisaab se sorted, count se nahi — ek P0 jisme ek user hai wo us P3 se zyada zaroori hai jisme baarah hazaar.<br>
  ${days.map(d => `${esc(d.product)} &middot; ${esc(d.today.anomaliesFile ?? '')}`).join('<br>')}
</footer>`

  const out = join(STATE_DIR, `report-${reportDate}.html`)
  writeFileSync(out, html)
  return { path: out, date: reportDate, gains: allGains.length, newUsers, rises: allRises.length }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v === undefined ? true : v]
  }))
  const r = buildReport({
    products: (args.products || 'tarot,astro').split(','),
    date: args.date || null
  })
  if (!r) throw new Error('no state files yet — run daily.js first')
  console.log(`report : ${r.path}`)
  console.log(`  naya : ${r.gains} check, ${r.newUsers} users`)
  console.log(`  rates: ${r.rises} badhe`)
  console.log(`\nopen "${r.path}"`)
}
