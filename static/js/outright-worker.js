// Works the tournament outright odds out away from the page, so a busy
// night's run-throughs never make the scores stutter. The page sends the same
// inputs it would give outrightOdds and gets the odds back.
const load = import(`./outright.js${self.location.search}`);
self.onmessage = async e => {
  let odds = null;
  try { odds = (await load).outrightOdds(e.data.args); } catch { odds = null; }
  self.postMessage({ job: e.data.job, odds });
};
