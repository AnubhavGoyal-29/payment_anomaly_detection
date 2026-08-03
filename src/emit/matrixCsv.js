// The cohort matrix: rows are cases (one per check), columns are cohort months. This is
// the view that answers "is this getting better or worse", and it makes a regression
// introduced in one month obvious against the months either side.

export function buildMatrix (counts, scanned, stageByCode, titleByCode, severityByCode) {
  const months = [...new Set([...counts.keys()].map(k => k.split('|')[1]))].sort()
  const codes = [...new Set([...counts.keys()].map(k => k.split('|')[0]))]

  codes.sort((a, b) =>
    (stageByCode.get(a) - stageByCode.get(b)) || a.localeCompare(b))

  const columns = ['stage', 'code', 'severity', 'case', ...months, 'total']
  const rows = codes.map(code => {
    const row = {
      stage: stageByCode.get(code),
      code,
      severity: severityByCode.get(code),
      case: titleByCode.get(code)
    }
    let total = 0
    for (const m of months) {
      const n = counts.get(`${code}|${m}`) || 0
      row[m] = n || ''
      total += n
    }
    row.total = total
    return row
  })

  // A denominator row, so a count can be read as a rate rather than an absolute.
  const scannedRow = { stage: '', code: '', severity: '', case: 'USERS SCANNED' }
  let scannedTotal = 0
  for (const m of months) {
    scannedRow[m] = scanned.get(m) || 0
    scannedTotal += scanned.get(m) || 0
  }
  scannedRow.total = scannedTotal

  return { columns, rows: [scannedRow, ...rows], months }
}
