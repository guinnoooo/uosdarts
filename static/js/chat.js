import { sb, esc, toast } from './db.js';
import { loadAccount } from './betting.js';

// Live chat for one match. It lives in its own box under the match, outside
// the part of the page that's redrawn on every score, so a half-typed
// message is never lost.

// Switch to turn the chat off everywhere without removing it.
export const CHAT_ENABLED = true;

// The chat needs an account (an email that's been confirmed), so every
// message is tied to someone. People can still post under any name they
// like; tapping a name shows the account's real name. Messages can be
// reacted to with 😆.
const NAME_KEY = 'uosdarts:chatname';
const savedName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = n => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };
export async function mountChat(host, matchId) {
  if (!CHAT_ENABLED) {
    host.innerHTML = `<section class="chat">
      <h2>Chat</h2>
      <p class="muted">The chat feature is temporarily disabled.</p>
    </section>`;
    return;
  }
  const acc = await loadAccount();
  if (acc) { openChat(host, matchId, acc); return; }
  const next = encodeURIComponent(location.pathname + location.search);
  host.innerHTML = `<section class="chat">
    <h2>Chat</h2>
    <p class="muted small"><a href="/account/?next=${next}">Log in</a> to join the chat.</p>
  </section>`;
}

async function openChat(host, matchId, acc) {
  const C = { msgs: [], admin: false, reacts: {}, real: {} };
  host.innerHTML = `<section class="chat">
    <h2>Chat</h2>
    <div class="chat-list" aria-live="polite"><p class="muted small">Loading…</p></div>
    ${acc.banned ? '<p class="muted small">Blocked from the chat.</p>' : `<form class="chat-form" autocomplete="off">
      <input name="name" class="chat-name" maxlength="30" placeholder="Name to show" value="${esc(savedName() || acc.display_name)}">
      <div class="chat-send">
        <input name="body" maxlength="280" placeholder="Say something…" required>
        <button class="primary">Send</button>
      </div>
    </form>`}
  </section>`;
  const list = host.querySelector('.chat-list');
  const form = host.querySelector('.chat-form');

  const time = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function draw(stick) {
    list.innerHTML = C.msgs.length
      ? C.msgs.map(m => {
          const r = C.reacts[m.id];
          return `<div class="chat-msg" data-id="${m.id}">
          <button class="link chat-who" data-who="${m.id}" title="See who this is">${esc(m.author)}</button>
          ${C.real[m.id] ? `<span class="chat-real">(${esc(C.real[m.id])})</span>` : ''}
          <span class="chat-body">${esc(m.body)}</span>
          <span class="chat-time">${time(m.created_at)}</span>
          <button class="chat-react${r?.mine ? ' on' : ''}" data-react="${m.id}" aria-label="React with laughing face">😆${r?.n ? ` <b>${r.n}</b>` : ''}</button>
          ${C.admin ? `<button class="link chat-del" data-chatdel="${m.id}" aria-label="Delete message">✕</button>` : ''}
        </div>`;
        }).join('')
      : '<p class="muted small">No messages yet.</p>';
    // Tall enough for the latest five messages; anything older scrolls.
    const rows = [...list.querySelectorAll('.chat-msg')];
    list.style.maxHeight = rows.length > 5
      ? `${rows.slice(-5).reduce((h, r) => h + r.offsetHeight, 0) + 12}px` : '';
    if (stick) list.scrollTop = list.scrollHeight;
  }

  const { data, error } = await sb.from('match_chat').select('*').eq('match_id', matchId)
    .order('id', { ascending: false }).limit(150);
  if (error) { host.innerHTML = ''; return; }   // chat not set up yet (migration-024)
  C.msgs = (data ?? []).reverse();
  const counts = async () => {
    const r = await sb.rpc('chat_reaction_counts', { p_match: matchId });
    if (!r.error) { C.reacts = r.data ?? {}; draw(nearBottom()); }
  };
  draw(true);
  counts();
  let countTimer = null;
  const countsSoon = () => { clearTimeout(countTimer); countTimer = setTimeout(counts, 300); };

  // Admins get a delete button on each message.
  sb.rpc('my_admin_role').then(({ data: role }) => { if (role) { C.admin = true; draw(nearBottom()); } });

  sb.channel(`chat-${matchId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'match_chat', filter: `match_id=eq.${matchId}` },
      ({ new: m }) => {
        if (C.msgs.some(x => x.id === m.id)) return;
        const stick = nearBottom();
        C.msgs.push(m);
        draw(stick);
      })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_reactions', filter: `match_id=eq.${matchId}` }, countsSoon)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_reactions' },
      ({ old }) => { if (C.msgs.some(x => x.id === old.message_id)) countsSoon(); })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'match_chat' },
      ({ old }) => {
        if (!C.msgs.some(x => x.id === old.id)) return;
        C.msgs = C.msgs.filter(x => x.id !== old.id);
        draw(nearBottom());
      })
    .subscribe();

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.elements.name.value.trim().replace(/\s+/g, ' ') || acc.display_name;
    const body = form.elements.body.value.trim();
    if (!body) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { data: newId, error: err } = await sb.rpc('post_chat', { p_match: matchId, p_name: name, p_body: body });
      if (err) throw err;
      saveName(name);
      form.elements.body.value = '';
      // Show it straight away; the live update for it is then ignored.
      if (!C.msgs.some(x => x.id === newId)) {
        C.msgs.push({ id: newId, author: name, body, created_at: new Date().toISOString() });
        draw(true);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      form.elements.body.focus();
    }
  });

  host.addEventListener('click', async e => {
    // Tap a name to see the real name behind it; tap again to hide it.
    const who = e.target.closest('[data-who]')?.dataset.who;
    if (who) {
      if (C.real[who]) { delete C.real[who]; draw(nearBottom()); return; }
      const { data: real, error: err } = await sb.rpc('chat_real_name', { p_message: Number(who) });
      if (err) { toast(err.message); return; }
      C.real[who] = real ?? 'deleted account';
      draw(nearBottom());
      return;
    }
    const react = e.target.closest('[data-react]')?.dataset.react;
    if (react) {
      if (acc.banned) { toast('Your account can\'t react in the chat'); return; }
      // Show it straight away, then settle on the real count.
      const r = C.reacts[react] ?? { n: 0, mine: false };
      C.reacts[react] = { n: Math.max(0, r.n + (r.mine ? -1 : 1)), mine: !r.mine };
      draw(nearBottom());
      const { error: err } = await sb.rpc('toggle_reaction', { p_message: Number(react) });
      if (err) toast(err.message);
      countsSoon();
      return;
    }
    const id = e.target.closest('[data-chatdel]')?.dataset.chatdel;
    if (!id || !confirm('Delete this message?')) return;
    const { error: err } = await sb.rpc('admin_delete_chat', { p_id: Number(id) });
    if (err) { toast(err.message); return; }
    C.msgs = C.msgs.filter(x => x.id !== Number(id));
    draw(nearBottom());
  });
}
