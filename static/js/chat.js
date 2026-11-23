import { sb, esc, toast, ensureSignedIn } from './db.js';

// Live chat for one match. It lives in its own box under the match, outside
// the part of the page that's redrawn on every score, so a half-typed
// message is never lost.
const NAME_KEY = 'uosdarts:chatname';
const savedName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = n => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };

// Switch to turn the chat off everywhere without removing it. Set back to
// true to bring it back exactly as it was.
export const CHAT_ENABLED = false;

// Chat is behind a password. Once entered, it stays unlocked for this
// browser until the super admin changes it.
export async function mountChat(host, matchId) {
  if (!CHAT_ENABLED) {
    host.innerHTML = `<section class="chat">
      <h2>Chat</h2>
      <p class="muted">The chat feature is temporarily disabled.</p>
    </section>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  const ok = session ? (await sb.rpc('chat_ok')).data === true : false;
  if (ok) { openChat(host, matchId); return; }

  host.innerHTML = `<section class="chat">
    <h2>Chat</h2>
    <form class="chat-lock" autocomplete="off">
      <p class="muted small">Enter the chat password to see and join the chat.</p>
      <div class="chat-send">
        <input name="pw" type="password" placeholder="Chat password" required>
        <button class="primary">Unlock</button>
      </div>
    </form>
  </section>`;
  const form = host.querySelector('.chat-lock');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await ensureSignedIn();
      const { error } = await sb.rpc('chat_unlock', { p_password: form.elements.pw.value });
      if (error) throw error;
      openChat(host, matchId);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

async function openChat(host, matchId) {
  const C = { msgs: [], admin: false };
  host.innerHTML = `<section class="chat">
    <h2>Chat</h2>
    <div class="chat-list" aria-live="polite"><p class="muted small">Loading…</p></div>
    <form class="chat-form" autocomplete="off">
      <input name="name" class="chat-name" maxlength="30" placeholder="Your name" value="${esc(savedName())}" required>
      <div class="chat-send">
        <input name="body" maxlength="280" placeholder="Say something…" required>
        <button class="primary">Send</button>
      </div>
    </form>
  </section>`;
  const list = host.querySelector('.chat-list');
  const form = host.querySelector('.chat-form');

  const time = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function draw(stick) {
    list.innerHTML = C.msgs.length
      ? C.msgs.map(m => `<div class="chat-msg" data-id="${m.id}">
          <span class="chat-who">${esc(m.author)}</span>
          <span class="chat-body">${esc(m.body)}</span>
          <span class="chat-time">${time(m.created_at)}</span>
          ${C.admin ? `<button class="link chat-del" data-chatdel="${m.id}" aria-label="Delete message">✕</button>` : ''}
        </div>`).join('')
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
  draw(true);

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
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'match_chat' },
      ({ old }) => {
        if (!C.msgs.some(x => x.id === old.id)) return;
        C.msgs = C.msgs.filter(x => x.id !== old.id);
        draw(nearBottom());
      })
    .subscribe();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const body = form.elements.body.value.trim();
    if (!name || !body) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await ensureSignedIn();
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
    const id = e.target.closest('[data-chatdel]')?.dataset.chatdel;
    if (!id || !confirm('Delete this message?')) return;
    const { error: err } = await sb.rpc('admin_delete_chat', { p_id: Number(id) });
    if (err) { toast(err.message); return; }
    C.msgs = C.msgs.filter(x => x.id !== Number(id));
    draw(nearBottom());
  });
}
