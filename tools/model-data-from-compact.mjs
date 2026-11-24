// Turns the output of supabase/model-eval-compact.sql into the
// model-data.json that tools/model-eval.mjs reads.
//   node tools/model-data-from-compact.mjs compact.txt model-data.json
import fs from 'fs';
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const fig = s => { if (!s) return null; const [darts, avg, first9, dbl] = s.split(','); return { darts: +darts, avg, first9, dbl_pct: dbl ? dbl + '%' : null }; };
const form = s => { if (!s) return null; const [wdarts, avg, first9, dbl] = s.split(','); return { wdarts: +wdarts, avg, first9, dbl_pct: dbl ? dbl + '%' : null }; };
const nz = s => s === '' || s == null ? null : +s;
const out = lines.map(l => {
  const [t, w, lg, c1, c2, f1, f2, pr1, pr2, rec, oom, fmt, ex, h2h] = l.split('|');
  const [p1_played, p1_won, p2_played, p2_won] = rec.split(',').map(Number);
  const [o1, o2] = oom.split(',').map(Number);
  const [legs_to_win, sets_to_win, start_score] = fmt.split(',').map(Number);
  const [r1, rd1, r2, rd2, sd1, sd2] = ex.split(',').map(nz);
  const legs = [];
  for (let i = 0; i + 1 < lg.length; i += 2) legs.push({ no: i / 2 + 1, starter: +lg[i] || null, winner: +lg[i + 1], bull_off: false });
  return { taken_at: t, winner: +w, legs, features: {
    p1: fig(c1), p2: fig(c2), p1_form: form(f1), p2_form: form(f2), p1_prov: nz(pr1), p2_prov: nz(pr2),
    p1_played, p1_won, p2_played, p2_won, oom: { p1: o1, p2: o2 }, legs_to_win, sets_to_win: sets_to_win || null, start_score,
    p1_rating: r1, p1_rd: rd1, p2_rating: r2, p2_rd: rd2, p1_sd: sd1, p2_sd: sd2,
    h2h: h2h ? h2h.split(';').map(x => { const [date, a, b] = x.split(','); return { date, p1_legs: +a, p2_legs: +b }; }) : [],
  } };
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(out.length, 'matches', out.reduce((t, d) => t + d.legs.length, 0), 'legs');
