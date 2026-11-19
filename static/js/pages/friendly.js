import { sb, esc, toast, ensureSignedIn, showLoadError } from '../db.js';

// Start a friendly: two names, a length and a start score. Friendlies don't
// count for anything; they're there so a match can be scored and watched.
const app = document.getElementById('app');
const range = n => Array.from({ length: n }, (_, i) => i + 1);
const PW_KEY = 'uosdarts:friendlypw';
const savedPw = () => { try { return localStorage.getItem(PW_KEY) ?? ''; } catch { return ''; } };
const rememberPw = v => { try { localStorage.setItem(PW_KEY, v); } catch { /* private mode */ } };

async function init() {
  const [{ data: enabled, error }, players] = await Promise.all([
    sb.rpc('friendlies_enabled'),
    sb.from('players').select('name').order('name'),
  ]);
  if (error) throw error;
  if (!enabled) {
    app.innerHTML = `<section class="panel narrow"><h1>Friendlies</h1>
      <p class="muted">Friendlies are switched off at the moment.</p>
      <a href="/">Back to the match hub</a></section>`;
    return;
  }
  const names = (players.data ?? []).map(p => `<option value="${esc(p.name)}">`).join('');
  app.innerHTML = `<form class="panel narrow friendly-form" data-form="friendly">
    <h1>Start a friendly</h1>
    <label>Player 1 <input name="p1" list="player-names" maxlength="40" autocomplete="off" required></label>
    <label>Player 2 <input name="p2" list="player-names" maxlength="40" autocomplete="off" required></label>
    <datalist id="player-names">${names}</datalist>
    <p class="muted small">Pick names from the order of merit list to get GuinnessBet odds. Friendlies never count towards the order of merit or anyone's stats.</p>
    <div class="seg friendly-format" role="radiogroup" aria-label="Format">
      <label><input type="radio" name="format" value="legs" checked> Legs</label>
      <label><input type="radio" name="format" value="sets"> Sets</label>
    </div>
    <div class="row friendly-opts">
      <label class="sets-only" hidden>First to
        <select name="sets">${range(10).map(n => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n} set${n > 1 ? 's' : ''}</option>`).join('')}</select>
      </label>
      <label><span class="legs-label">First to</span>
        <select name="legs">${range(10).map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} leg${n > 1 ? 's' : ''}</option>`).join('')}</select>
      </label>
      <label>Start score
        <select name="start">${[501, 301, 701, 170, 101].map(n => `<option ${n === 501 ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
    </div>
    <label>Friendly password <input name="pw" type="password" autocomplete="off" value="${esc(savedPw())}" required></label>
    <button class="primary big">Start scoring</button>
    <a href="/#friendlies" class="muted small">Back</a>
  </form>`;
}

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await ensureSignedIn();
    const { data: matchId, error } = await sb.rpc('create_friendly', {
      p_password: String(f.get('pw')),
      p_p1: String(f.get('p1')),
      p_p2: String(f.get('p2')),
      p_legs: Number(f.get('legs')),
      p_start: Number(f.get('start')),
      p_sets: f.get('format') === 'sets' ? Number(f.get('sets')) : null,
    });
    if (error) throw error;
    rememberPw(String(f.get('pw')).trim());
    location.href = `/match/?id=${matchId}`;
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// Sets: pick the number of sets, and the legs box becomes legs per set.
app.addEventListener('change', e => {
  if (e.target.name !== 'format') return;
  const sets = e.target.value === 'sets';
  app.querySelector('.sets-only').hidden = !sets;
  app.querySelector('.legs-label').textContent = sets ? 'Legs a set' : 'First to';
});

init().catch(e => showLoadError(app, e));
