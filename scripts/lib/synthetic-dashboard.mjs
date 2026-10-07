#!/usr/bin/env node
/**
 * SYNTHETIC test dashboard generator (LOCAL TESTING ONLY).
 *
 * Builds a self-contained HTML candidate dashboard in the shape real uploaded
 * dashboards have and dashboard-bridge.js enhances: a <table> with
 * "Candidate" and "Status" columns whose rendered rows match window.__ROWS
 * one-to-one (see syncActionColumns / syncTablePaginationGeneric there; the
 * Status column is what lets the bridge re-attach after a re-render): its own
 * search box and location/experience filters re-render the table and
 * publish the current result set as window.__ROWS, and the bridge adds the
 * Action column, notes, pagination and action sorting on top — exactly as
 * it does for real uploaded dashboards.
 *
 * Every name, company and role is generated from fixed fictional word
 * lists; nothing is derived from any real dashboard or person. The page
 * says so in a banner.
 *
 *   node scripts/lib/synthetic-dashboard.mjs --count 60 --title "..." > out.html
 */
import { fileURLToPath } from 'node:url'

const FIRST = [
  'Asha',
  'Bilal',
  'Chloe',
  'Dev',
  'Elena',
  'Farid',
  'Grace',
  'Hiro',
  'Isla',
  'Jonah',
  'Kavya',
  'Liam',
  'Maya',
  'Nikhil',
  'Olivia',
  'Pranav',
  'Quinn',
  'Rhea',
  'Samir',
  'Tara',
  'Uma',
  'Victor',
  'Wen',
  'Yara',
  'Zane',
]
const LAST = [
  'Abbott',
  'Bhatt',
  'Castell',
  'Dorsey',
  'Ekwueme',
  'Fenwick',
  'Gallo',
  'Hartley',
  'Iyengar',
  'Jovanovic',
  'Kowal',
  'Lindqvist',
  'Mehra',
  'Novak',
  'Okafor',
  'Pellegrini',
  'Quarles',
  'Rasmussen',
  'Sato',
  'Thorne',
]
const ROLES = [
  'Senior Data Engineer',
  'Data Engineer',
  'Analytics Engineer',
  'Platform Engineer',
  'Data Platform Lead',
  'BI Engineer',
]
const COMPANIES = [
  'Northwind Telecom (fictional)',
  'Contoso Networks (fictional)',
  'Fabrikam Mobile (fictional)',
  'Tailspin Connect (fictional)',
  'Adatum Wireless (fictional)',
  'Litware Comms (fictional)',
]
const LOCATIONS = ['London', 'Manchester', 'Birmingham', 'Leeds', 'Remote (UK)']
const AVAILABILITY = ['Open to work', 'Passive', 'Interviewing elsewhere']

export function syntheticCandidates(count) {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}${i >= FIRST.length ? ` ${Math.floor(i / FIRST.length) + 1}` : ''}`,
    role: ROLES[(i * 5) % ROLES.length],
    company: COMPANIES[(i * 3) % COMPANIES.length],
    location: LOCATIONS[(i * 2) % LOCATIONS.length],
    years: 3 + ((i * 11) % 14),
    status: AVAILABILITY[(i * 4) % AVAILABILITY.length],
  }))
}

export function buildSyntheticDashboardHtml({ title, count }) {
  const data = JSON.stringify(syntheticCandidates(count))
  const safeTitle = title.replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 20px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; background: #fff; }
  .synthetic { padding: 10px 14px; border: 1px dashed #b45309; border-radius: 10px; background: #fffbeb; color: #92400e; font-size: 13px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #475569; font-size: 13px; margin: 0 0 16px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .controls input, .controls select { font: inherit; font-size: 14px; height: 36px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 8px; min-width: 0; }
  .controls input { flex: 1 1 220px; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  .empty { padding: 24px; text-align: center; color: #64748b; }
  tbody tr.cand { cursor: pointer; }
  tbody tr.cand:hover { background: #f8fafc; }
  td.detail { background: #f1f5f9; white-space: normal; color: #334155; font-size: 13px; }
</style>
</head>
<body>
<div class="synthetic">SYNTHETIC LOCAL TEST DATA — every candidate, company and role on this page is generated and fictional.</div>
<h1>${safeTitle}</h1>
<p class="sub">Talent landscape · <span id="count"></span></p>
<div class="controls">
  <input id="q" type="search" placeholder="Search candidate, role or company" aria-label="Search">
  <select id="loc" aria-label="Location"><option value="">All locations</option></select>
  <select id="exp" aria-label="Experience">
    <option value="">Any experience</option>
    <option value="0-5">0–5 years</option>
    <option value="6-10">6–10 years</option>
    <option value="11-99">11+ years</option>
  </select>
</div>
<div class="table-wrap">
<table id="candidates">
  <thead><tr><th>#</th><th>Candidate</th><th>Status</th><th>Current role</th><th>Company</th><th>Location</th><th>Experience</th></tr></thead>
  <tbody></tbody>
</table>
</div>
<script>
(function () {
  var DATA = ${data};
  var q = document.getElementById('q');
  var loc = document.getElementById('loc');
  var exp = document.getElementById('exp');
  var tbody = document.querySelector('#candidates tbody');
  var countEl = document.getElementById('count');
  Array.from(new Set(DATA.map(function (c) { return c.location; }))).sort().forEach(function (l) {
    var o = document.createElement('option'); o.value = l; o.textContent = l; loc.appendChild(o);
  });
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function render() {
    var term = q.value.trim().toLowerCase();
    var range = exp.value ? exp.value.split('-').map(Number) : null;
    var rows = DATA.filter(function (c) {
      if (term && (c.name + ' ' + c.role + ' ' + c.company).toLowerCase().indexOf(term) === -1) return false;
      if (loc.value && c.location !== loc.value) return false;
      if (range && (c.years < range[0] || c.years > range[1])) return false;
      return true;
    });
    window.__ROWS = rows;
    countEl.textContent = rows.length + ' of ' + DATA.length + ' candidates';
    tbody.innerHTML = rows.length
      ? rows.map(function (c) {
          return '<tr class="cand" data-rank="' + c.rank + '"><td>' + c.rank + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.status) + '</td><td>' + esc(c.role) + '</td><td>' + esc(c.company) + '</td><td>' + esc(c.location) + '</td><td>' + c.years + ' yrs</td></tr>';
        }).join('')
      : '<tr><td class="empty" colspan="7">No candidates match these filters.</td></tr>';
  }
  // Clicking a candidate toggles an inline detail row right after it (the
  // same shape real dashboards use, where the host adds its notes panel).
  // Inserted/removed in place: the result set (window.__ROWS) is unchanged.
  tbody.addEventListener('click', function (e) {
    var target = e.target;
    if (target.closest('[data-longlist-action-cell], [data-longlist-notes-panel], button, select, textarea, input, a')) return;
    var tr = target.closest('tr.cand');
    if (!tr) return;
    var next = tr.nextElementSibling;
    if (next && !next.classList.contains('cand') && next.querySelector('td.detail')) { next.remove(); return; }
    var c = DATA.filter(function (x) { return String(x.rank) === tr.getAttribute('data-rank'); })[0];
    if (!c) return;
    var detail = document.createElement('tr');
    detail.innerHTML = '<td class="detail" colspan="7"><strong>' + esc(c.name) + '</strong> — synthetic profile: ' + esc(c.role) + ' at ' + esc(c.company) + ', ' + c.years + ' years, ' + esc(c.location) + '.</td>';
    tr.after(detail);
  });
  q.addEventListener('input', render);
  loc.addEventListener('change', render);
  exp.addEventListener('change', render);
  render();
})();
</script>
</body>
</html>
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const count = Number(arg('--count', '5'))
  const title = arg(
    '--title',
    `SYNTHETIC LYCA TEST DASHBOARD (${count} candidates)`,
  )
  process.stdout.write(buildSyntheticDashboardHtml({ title, count }))
}
