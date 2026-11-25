// Browser load test: tournament page under a flood of score updates, the
// Odds page with 48 matches, and a live match spectator, at 4x CPU slowdown
// (a mid-range phone). Needs a Hugo build in vtest/public and a stub of
// supabase-js that can emit realtime rows (not in the repo).
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw; import fs from 'fs'; import http from 'http'; import path from 'path';
const ROOT='/home/claude/vtest/public'; const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);let f=path.join(ROOT,p);
 if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');
 if(!fs.existsSync(f)){res.writeHead(404);return res.end('nf');}
 res.writeHead(200,{'content-type':MIME[path.extname(f)]??'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(8144,r));
const stub=fs.readFileSync('/home/claude/t22/stub.js','utf8');
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const H='http://localhost:8144';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

async function page(cpuSlow = 4) {
  const ctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  await ctx.route('**/esm.sh/@supabase/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:stub}));
  await ctx.addInitScript(() => { window.__long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {} });
  const pg=await ctx.newPage(); pg.on('console', m => { if (/reload|unknown/.test(m.text())) console.log('   page:', m.text()); }); const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlow });   // a mid-range phone
  await cdp.send('Performance.enable');
  return { pg, cdp, errs, ctx };
}
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
const report = async (name, pg, cdp, errs, t0, secs) => {
  const m = await metrics(cdp);
  const longs = await pg.evaluate(() => window.__long);
  console.log('   long tasks (ms):', longs.slice(0, 40).join(' '));
  const busy = (m.TaskDuration - t0.TaskDuration);
  console.log(`${name}: main thread busy ${(100 * busy / secs).toFixed(0)}% of the time, long tasks ${longs.length} (worst ${Math.round(Math.max(0, ...longs))} ms), heap ${(m.JSHeapUsedSize / 1e6).toFixed(1)} MB, errors ${errs.length ? errs : 'none'}`);
};

// 1. Tournament page, 64-player draw, 16 boards live, a flood of score updates.
{
  const { pg, cdp, errs, ctx } = await page();
  await pg.goto(H + '/tournament/?id=' + id(70), { waitUntil: 'networkidle' }); await pg.waitForTimeout(6000);
  await pg.evaluate(() => window.__long = []);
  await pg.evaluate(() => { window.__fromLog = []; });
  const t0 = await metrics(cdp); const secs = 30;
  // 16 boards, each scoring a visit every ~1.6 s (twice the pace of a real night), each visit firing two row updates.
  await pg.evaluate(async secs => {
    const live = window.__M.filter(m => m.status === 'live');
    const end = Date.now() + secs * 1000; let k = 0;
    while (Date.now() < end) {
      const m = live[k++ % live.length];
      const who = m.turn; m[`p${who}_rem`] = Math.max(2, m[`p${who}_rem`] - 45); m.turn = 3 - who; m.version++;
      if (m[`p${who}_rem`] <= 2) { m[`p${who}_legs`]++; m.p1_rem = 501; m.p2_rem = 501; }
      window.__emit('matches', { ...m, p1: undefined, p2: undefined });
      window.__emit('matches', { ...m, p1: undefined, p2: undefined });
      await new Promise(r => setTimeout(r, 100));
    }
  }, secs);
  console.log('   table reads during run:', await pg.evaluate(() => { const c = {}; for (const n of window.__fromLog ?? []) c[n] = (c[n] ?? 0) + 1; return JSON.stringify(c); }));
  await report('Tournament page, 16 boards live, 20 updates a second', pg, cdp, errs, t0, secs);
  console.log('   page shows', await pg.$$eval('a[href*="/match/?id="]', e => e.length), 'match links; first:', (await pg.$$eval('a[href*="/match/?id="]', e => e.map(x => x.innerText.replace(/\s+/g, ' '))))[0]);
  await ctx.close();
}

// 2. Odds page with 48 upcoming matches over 6 events: open everything, tap 30 prices.
{
  const { pg, cdp, errs, ctx } = await page();
  await pg.addInitScript(() => { window.__bigodds = true; localStorage.removeItem('uosdarts:acca'); });
  await pg.goto(H + '/odds/', { waitUntil: 'networkidle' }); await pg.waitForTimeout(800);
  await pg.evaluate(() => { window.__bigodds = true; });
  await pg.reload({ waitUntil: 'networkidle' }); await pg.waitForTimeout(800);
  await pg.evaluate(() => window.__long = []);
  const t0 = await metrics(cdp); const start = Date.now();
  for (let g = 0; g < 10; g++) { const s = await pg.$('.ob-group:not([open]) > summary'); if (!s) break; await s.click(); await pg.waitForTimeout(80); }
  const tapTimes = [];
  for (let i = 0; i < 30; i++) {
    const btns = await pg.$$('.ob-match .odds-row .ob-pick');
    const t = Date.now(); await btns[(i * 3) % btns.length].click(); await pg.waitForFunction(() => true); tapTimes.push(Date.now() - t);
  }
  for (let g = 0; g < 10; g++) { const s = await pg.$('.ob-more:not([open]) > summary'); if (!s) break; await s.click(); await pg.waitForTimeout(80); }
  const secs = (Date.now() - start) / 1000;
  await report(`Odds page, ${await pg.$$eval('.ob-match', e => e.length)} matches, 30 taps, 10 market folds opened`, pg, cdp, errs, t0, secs);
  tapTimes.sort((a, b) => a - b);
  console.log('   tap to redraw: median', tapTimes[15], 'ms, worst', tapTimes.at(-1), 'ms; acca bar:', (await pg.$$eval('.acca-bar', e => e.map(x => x.innerText.replace(/\s+/g, ' '))))[0]);
  await ctx.close();
}

// 3. A spectator on a live match, two updates a second.
{
  const { pg, cdp, errs, ctx } = await page();
  await pg.goto(H + '/match/?id=' + id(4000), { waitUntil: 'networkidle' }); await pg.waitForTimeout(1000);
  await pg.evaluate(() => window.__long = []);
  const t0 = await metrics(cdp); const secs = 20;
  await pg.evaluate(async secs => {
    const m = window.__M.find(x => x.id.endsWith('000000004000'));
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) { m.version++; m.turn = 3 - m.turn; window.__emit('matches', { ...m, p1: undefined, p2: undefined }); await new Promise(r => setTimeout(r, 500)); }
  }, secs);
  await report('Live match page, spectator', pg, cdp, errs, t0, secs);
  await ctx.close();
}
await b.close(); srv.close();
