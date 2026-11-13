// Super admin: players, points and who the admins are.
// Everything here is guarded in the database as well, so a plain admin who
// finds this page can read it but cannot change anything.

import { sb, showLoadError, esc, toast, toLoginEmail, toUsername } from '../db.js';

const app = document.getElementById('app');
const SEASON = '2026/27';

const S = {
  role: null, players: [], admins: [], sel: null, points: [], usage: null,
  filter: '', mergeInto: '',
};

const check = r => { if (r.error) throw r.error; return r.data; };

// ---------------------------------------------------------------- data

async function loadInner() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) {
    app.innerHTML = `<div class="panel narrow center">
      <h2>Super admin</h2>
      <p class="muted">Sign in on the <a href="/admin/">admin page</a> first.</p>
    </div>`;
    return;
  }

  S.role = check(await sb.rpc('my_admin_role'));
  if (S.role !== 'super') {
    app.innerHTML = `<div class="panel narrow center">
      <h2>Super admin</h2>
      <p class="muted">Signed in as ${esc(toUsername(session.user.email))}${S.role ? ` (${esc(S.role)})` : ''}.
        This page is for super admins.</p>
      <p><a href="/admin/">Back to the admin page</a></p>
    </div>`;
    return;
  }

  S.players = check(await sb.from('players').select('*').order('name'));
  S.admins = check(await sb.rpc('super_list_admins'));
  if (S.sel) {
    S.sel = S.players.find(p => p.id === S.sel.id) ?? null;
  }
  if (S.sel) await loadPlayer(S.sel.id);
  render();
}

async function loadPlayer(id) {
  S.points = check(await sb.rpc('player_points', { p_player: id, p_season: SEASON }));
  const u = check(await sb.rpc('player_usage', { p_player: id }));
  S.usage = Array.isArray(u) ? u[0] : u;
}

// ---------------------------------------------------------------- rendering

function playersPanel() {
  const f = S.filter.toLowerCase();
  const list = f ? S.players.filter(p => p.name.toLowerCase().includes(f)) : S.players;
  return `<section class="panel">
    <h2>Players (${S.players.length})</h2>
    <div class="player-add">
      <input type="text" id="p-filter" placeholder="Search players" value="${esc(S.filter)}" autocomplete="off">
      <input type="text" id="p-new" placeholder="New player name" autocomplete="off">
      <button data-act="add-player" class="primary">Add</button>
    </div>
    <div class="chips">${list.map(p => `<button class="chip${S.sel?.id === p.id ? ' on' : ''}" data-pick="${p.id}">${esc(p.name)}</button>`).join('')
      || '<p class="muted">No players match.</p>'}</div>
  </section>`;
}

function playerPanel() {
  const p = S.sel;
  if (!p) return '';
  const u = S.usage ?? { matches: 0, tournaments: 0, point_rows: 0 };
  const total = S.points.reduce((a, r) => a + Number(r.points), 0);

  return `<section class="panel settings-block" style="display:block">
    <h3>${esc(p.name)}</h3>

    <div class="row">
      <label>Name <input type="text" id="p-name" value="${esc(p.name)}"></label>
      <button data-act="rename" class="primary">Save name</button>
      <span class="muted small">Profile file: <code>${esc(p.slug)}.yaml</code></span>
    </div>

    <div class="row">
      <span class="muted small">In ${u.matches} match${u.matches === 1 ? '' : 'es'},
        ${u.tournaments} tournament${u.tournaments === 1 ? '' : 's'},
        ${u.point_rows} points entr${u.point_rows === 1 ? 'y' : 'ies'}.</span>
    </div>

    <h3>Order of merit points · ${SEASON} · ${total}</h3>
    <table class="points-list">
      <thead><tr><th>Event</th><th>Key</th><th>Points</th><th>Source</th><th></th></tr></thead>
      <tbody>
        ${S.points.map(r => `<tr>
          <td>${esc(r.event_name ?? '')}${r.is_pc ? ' <span class="tag">PC</span>' : ''}${r.is_major ? ' <span class="tag">Major</span>' : ''}</td>
          <td class="mono">${esc(r.event_key)}</td>
          <td class="mono">${Number(r.points)}</td>
          <td class="muted small">${r.from_tournament ? 'from a tournament' : 'entered by hand'}</td>
          <td>${r.from_tournament ? '' : `<button data-delpts="${r.id}" title="Remove">&times;</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing scored yet.</td></tr>'}
      </tbody>
    </table>
    <p class="muted small">Entries from a tournament are changed by fixing the result and awarding its points again.</p>

    <div class="row manual-points">
      <label>Event key <input type="text" id="pt-key" placeholder="e.g. ham_cup"></label>
      <label>Shown as <input type="text" id="pt-name" placeholder="e.g. Ham Cup"></label>
      <label>Points <input type="number" id="pt-points" step="50" value="0"></label>
      <label class="chk"><input type="checkbox" id="pt-pc"> PC</label>
      <label class="chk"><input type="checkbox" id="pt-major"> Major</label>
      <button data-act="set-points" class="primary">Add or update</button>
    </div>

    <div class="row merge-row">
      <label>Merge this player into
        <select id="p-merge">
          <option value="">Pick a player</option>
          ${S.players.filter(x => x.id !== p.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
        </select></label>
      <button data-act="merge">Merge</button>
      <span class="muted small">Use this for a name typed twice. Everything moves across and this one is removed.</span>
    </div>

    <div class="row danger">
      <button data-act="delete-player">Delete player</button>
      <span class="muted small">Only possible while they have no matches, tournaments or points.</span>
    </div>
  </section>`;
}

function adminsPanel() {
  return `<section class="panel">
    <h2>Admin logins</h2>
    <table class="points-list">
      <thead><tr><th>Username</th><th>Level</th><th>Added</th><th></th></tr></thead>
      <tbody>${S.admins.map(a => `<tr>
        <td>${esc(toUsername(a.email) || '(unknown)')}</td>
        <td>${a.role === 'super' ? '<b>super</b>' : 'admin'}</td>
        <td class="muted small">${new Date(a.added_at).toLocaleDateString('en-GB')}</td>
        <td><button data-rmadmin="${a.user_id}" data-email="${esc(toUsername(a.email) ?? '')}">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="row">
      <label>Username <input type="text" id="a-email" placeholder="committee"></label>
      <label>Level
        <select id="a-role"><option value="admin">admin</option><option value="super">super</option></select>
      </label>
      <button data-act="set-admin" class="primary">Grant</button>
    </div>
    <p class="muted small">The account has to exist first: create it in the Supabase dashboard under
      Authentication → Users, with the email <code>username@uosdarts.com</code> and
      <b>Auto Confirm User</b> ticked. Then grant the username here. An <b>admin</b> runs tournaments.
      A <b>super</b> can also do everything on this page.</p>
  </section>`;
}

function render() {
  if (S.role !== 'super') return;
  app.innerHTML = `<div class="admin-head">
      <h1>Super admin</h1>
      <a href="/admin/" class="muted small">Tournament admin</a>
    </div>
    ${playersPanel()}${playerPanel()}${adminsPanel()}`;
  const f = app.querySelector('#p-filter');
  if (f && S.filter) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

// ---------------------------------------------------------------- actions

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg, false);
  } catch (e) {
    toast(e.message);
  }
  await load();
}

const val = id => app.querySelector(id)?.value.trim() ?? '';

app.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;

  if (el.dataset.pick) {
    S.sel = S.players.find(p => p.id === el.dataset.pick) ?? null;
    if (S.sel) await loadPlayer(S.sel.id);
    render();
    return;
  }
  if (el.dataset.delpts) {
    await run(async () => check(await sb.rpc('super_delete_points', { p_id: Number(el.dataset.delpts) })),
      'Entry removed');
    return;
  }
  if (el.dataset.rmadmin) {
    if (!confirm(`Remove admin access for ${el.dataset.email}?`)) return;
    await run(async () => check(await sb.rpc('super_remove_admin', { p_user: el.dataset.rmadmin })),
      'Access removed');
    return;
  }

  switch (el.dataset.act) {
    case 'add-player': {
      const name = val('#p-new');
      if (!name) { toast('Type a name first'); break; }
      await run(async () => {
        const id = check(await sb.rpc('admin_add_player', { p_name: name }));
        S.sel = { id, name };
      }, `${name} added`);
      break;
    }
    case 'rename': {
      const name = val('#p-name');
      if (!name) { toast('Type a name first'); break; }
      await run(async () => check(await sb.rpc('super_rename_player', {
        p_player: S.sel.id, p_name: name,
      })), 'Name changed');
      break;
    }
    case 'set-points': {
      const key = val('#pt-key');
      if (!key) { toast('Give the event a key'); break; }
      await run(async () => check(await sb.rpc('super_set_points', {
        p_player: S.sel.id,
        p_season: SEASON,
        p_event_key: key,
        p_points: Number(val('#pt-points')) || 0,
        p_event_name: val('#pt-name') || key,
        p_is_pc: app.querySelector('#pt-pc').checked,
        p_is_major: app.querySelector('#pt-major').checked,
      })), 'Points saved');
      break;
    }
    case 'merge': {
      const into = val('#p-merge');
      if (!into) { toast('Pick who to merge into'); break; }
      const name = S.players.find(p => p.id === into)?.name;
      if (!confirm(`Merge ${S.sel.name} into ${name}? Everything moves across and ${S.sel.name} is removed.`)) break;
      await run(async () => {
        check(await sb.rpc('super_merge_players', { p_from: S.sel.id, p_into: into }));
        S.sel = null;
      }, 'Merged');
      break;
    }
    case 'delete-player':
      if (!confirm(`Delete ${S.sel.name}?`)) break;
      await run(async () => {
        check(await sb.rpc('super_delete_player', { p_player: S.sel.id }));
        S.sel = null;
      }, 'Player deleted');
      break;
    case 'set-admin': {
      const email = val('#a-email');
      if (!email) { toast('Type an email'); break; }
      await run(async () => check(await sb.rpc('super_set_admin', {
        p_email: toLoginEmail(email), p_role: app.querySelector('#a-role').value,
      })), 'Access granted');
      break;
    }
  }
});

app.addEventListener('input', e => {
  if (e.target.id === 'p-filter') {
    S.filter = e.target.value;
    render();
  }
});

async function load() {
  try {
    await loadInner();
  } catch (e) {
    showLoadError(app, e);
  }
}

load();
