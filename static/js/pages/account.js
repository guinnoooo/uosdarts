// Account: sign up with an email, log in, reset a password, and see your
// tokens and bets. An account only exists once the email is confirmed (the
// database makes it then), and it's what the chat and betting need.

import { sb, esc, toast, qs } from '../db.js';
import { loadAccount, fmtTokens, statusText, cancelButton } from '../betting.js';

const app = document.getElementById('app');
const next = qs('next');
const here = `${location.origin}/account/${next ? `?next=${encodeURIComponent(next)}` : ''}`;

let S = { view: 'login', email: '', sent: null, recovering: false };

const when = d => new Date(d).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function backLink() {
  return next ? `<p><a href="${esc(next)}">‹ Back to where you were</a></p>` : '';
}

function formsHtml() {
  if (S.sent) {
    return `<section class="panel account-box">
      <h2>Check your email</h2>
      <p>Confirmation link sent to <b>${esc(S.sent)}</b>.</p>
      <p class="muted small"><button class="link" data-act="resend">Send it again</button> · <button class="link" data-act="view" data-v="login">Log in</button></p>
    </section>`;
  }
  const tabs = `<div class="tabs account-tabs">
      <button class="tab${S.view === 'login' ? ' active' : ''}" data-act="view" data-v="login">Log in</button>
      <button class="tab${S.view === 'signup' ? ' active' : ''}" data-act="view" data-v="signup">Sign up</button>
    </div>`;
  if (S.view === 'signup') {
    return `<section class="panel account-box">${tabs}
      <form id="f-signup" autocomplete="on">
        <label>Name <input name="name" maxlength="30" minlength="2" required autocomplete="name"></label>
        <label>Email <input name="email" type="email" required autocomplete="email" value="${esc(S.email)}"></label>
        <label>Password <input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <button class="primary">Sign up</button>
      </form>
    </section>`;
  }
  if (S.view === 'forgot') {
    return `<section class="panel account-box">
      <h2>Reset your password</h2>
      <form id="f-forgot">
        <label>Email <input name="email" type="email" required autocomplete="email" value="${esc(S.email)}"></label>
        <button class="primary">Send a reset link</button>
      </form>
      <p><button class="link" data-act="view" data-v="login">Back to log in</button></p>
    </section>`;
  }
  return `<section class="panel account-box">${tabs}
    <form id="f-login" autocomplete="on">
      <label>Email <input name="email" type="email" required autocomplete="email" value="${esc(S.email)}"></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary">Log in</button>
    </form>
    <p><button class="link" data-act="view" data-v="forgot">Forgotten your password?</button></p>
  </section>`;
}

function recoverHtml() {
  return `<section class="panel account-box">
    <h2>Choose a new password</h2>
    <form id="f-newpw">
      <label>New password <input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="primary">Save password</button>
    </form>
  </section>`;
}


function accountHtml(a, bets, email) {
  if (!a) {
    return `<section class="panel account-box">
      <h2>Confirm your email</h2>
      <p>Click the link we sent to ${esc(email ?? 'your email')}.</p>
      <button data-act="logout">Log out</button>
    </section>`;
  }
  const list = bets.length ? `<table class="bets-list"><tbody>${bets.map(b => `<tr>
      <td class="l"><b>${esc(b.selection)}</b> at ${esc(b.price)}
        <span class="muted small">${esc(b.market)}${b.market.includes(b.tournament) ? '' : ` · ${esc(b.tournament)}`} · ${when(b.placed_at)}</span></td>
      <td>${fmtTokens(b.stake)}</td>
      <td class="bet-${b.status}">${statusText(b)} ${cancelButton(b)}</td>
    </tr>`).join('')}</tbody></table>`
    : '<p class="muted">No bets yet.</p>';
  if (a.can_bet === false) {
    return `${backLink()}<section class="panel account-box">
      <h2>${esc(a.display_name)}</h2>
      <p class="muted">Admin account: chat only.</p>
      <p class="muted small">${esc(a.email ?? '')} · <button class="link" data-act="logout">Log out</button></p>
    </section>`;
  }
  return `${backLink()}<section class="panel account-box">
      <h2>${esc(a.display_name)}</h2>
      ${a.banned ? '<p class="error">Blocked from chat and betting.</p>' : ''}
      <div class="token-row">
        <div><span class="muted small">Tokens</span><b>${fmtTokens(a.tokens)}</b></div>
        <div><span class="muted small">In open bets</span><b>${fmtTokens(a.in_play)}</b></div>
      </div>
      <p class="muted small">+500 on ${when(a.next_topup)}</p>
      <p class="muted small">${esc(a.email ?? '')} · <button class="link" data-act="logout">Log out</button></p>
    </section>
    <section class="panel"><h2>Your bets</h2>${list}</section>`;
}

async function render() {
  if (S.recovering) { app.innerHTML = recoverHtml(); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) { app.innerHTML = backLink() + formsHtml(); return; }
  const a = await loadAccount(true);
  const bets = a ? ((await sb.rpc('my_bets', { p_limit: 100 })).data ?? []) : [];
  // Fresh from the confirmation link, with somewhere to go back to.
  if (a && next && sessionStorage.getItem('uosdarts:justConfirmed')) {
    sessionStorage.removeItem('uosdarts:justConfirmed');
    location.replace(next);
    return;
  }
  app.innerHTML = accountHtml(a, bets, session.user.email);
}

app.addEventListener('click', async e => {
  const c = e.target.closest('[data-cancelbet]');
  if (c) {
    if (!confirm('Cancel this bet?')) return;
    c.disabled = true;
    const { error } = await sb.rpc('cancel_bet', { p_bet: Number(c.dataset.cancelbet) });
    if (error) { toast(error.message); c.disabled = false; return; }
    toast('Bet cancelled', false);
    render();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'view') { S.view = b.dataset.v; S.sent = null; render(); return; }
  if (act === 'logout') { await sb.auth.signOut(); toast('Logged out', false); render(); return; }
  if (act === 'resend' && S.sent) {
    const { error } = await sb.auth.resend({ type: 'signup', email: S.sent, options: { emailRedirectTo: here } });
    toast(error ? error.message : 'Sent again', !!error);
  }
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  const v = n => f.elements[n]?.value?.trim() ?? '';
  btn.disabled = true;
  try {
    if (f.id === 'f-signup') {
      const name = v('name').replace(/\s+/g, ' ');
      const { data: free } = await sb.rpc('name_available', { p_name: name });
      if (free === false) throw new Error('That name is taken. Try another.');
      S.email = v('email');
      const { error } = await sb.auth.signUp({
        email: S.email, password: f.elements.password.value,
        options: { data: { display_name: name }, emailRedirectTo: here },
      });
      if (error) throw error;
      S.sent = S.email;
      render();
    } else if (f.id === 'f-login') {
      S.email = v('email');
      const { error } = await sb.auth.signInWithPassword({ email: S.email, password: f.elements.password.value });
      if (error) {
        if (/confirm/i.test(error.message)) { S.sent = S.email; render(); return; }
        throw new Error(/invalid/i.test(error.message) ? 'Wrong email or password' : error.message);
      }
      if (next) { location.href = next; return; }
      render();
    } else if (f.id === 'f-forgot') {
      S.email = v('email');
      const { error } = await sb.auth.resetPasswordForEmail(S.email, { redirectTo: `${location.origin}/account/` });
      if (error) throw error;
      toast('Reset link sent', false);
      S.view = 'login';
      render();
    } else if (f.id === 'f-newpw') {
      const { error } = await sb.auth.updateUser({ password: f.elements.password.value });
      if (error) throw error;
      S.recovering = false;
      toast('Password changed', false);
      render();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') { S.recovering = true; render(); }
  if (event === 'SIGNED_IN' && /type=signup|access_token/.test(location.hash)) {
    sessionStorage.setItem('uosdarts:justConfirmed', '1');
  }
});

render().catch(err => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
