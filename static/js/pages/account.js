// Account: sign up with an email, log in, reset a password, and see your
// tokens. Bets are on GuinnessBet › My Bets. An account only exists once the email is confirmed (the
// database makes it then), and it's what the chat and betting need.
// Committee members log in here too, with their username, and are taken
// straight to the admin (or super admin) page.

import { sb, esc, toast, qs, toLoginEmail } from '../db.js';
import { loadAccount, fmtTokens } from '../betting.js';

const app = document.getElementById('app');
const next = qs('next');
const here = `${location.origin}/account/${next ? `?next=${encodeURIComponent(next)}` : ''}`;

let S = { view: 'login', email: '', sent: null, recovering: false, scorer: false };

const roleNow = async () => (await sb.rpc('my_admin_role')).data ?? null;

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
    ${S.scorer ? '<p class="muted small">You are scoring a match on this device. Logging in ends that, so hand the match over first.</p>' : ''}
    <form id="f-login" autocomplete="on">
      <label>Email or username <input name="email" type="text" required autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(S.email)}"></label>
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


// Links to the committee pages, for admins and super admins.
function staffHtml(role) {
  if (!role) return '';
  return `<section class="panel account-box">
    <h2>Committee</h2>
    <p><a href="/admin/">Admin page</a>${role === 'super' ? ' · <a href="/super/">Super admin</a>' : ''}</p>
  </section>`;
}

function accountHtml(a, email, role) {
  if (!a && role) {
    return `${staffHtml(role)}<section class="panel account-box">
      <p class="muted small">${esc(email ?? '')} · <button class="link" data-act="logout">Log out</button></p>
    </section>`;
  }
  if (!a) {
    return `<section class="panel account-box">
      <h2>Confirm your email</h2>
      <p>Click the link we sent to ${esc(email ?? 'your email')}.</p>
      <button data-act="logout">Log out</button>
    </section>`;
  }
  if (a.can_bet === false) {
    return `${backLink()}${staffHtml(role)}<section class="panel account-box">
      <h2>${esc(a.display_name)}</h2>
      <p class="muted">Admin account: chat only.</p>
      <p class="muted small">${esc(a.email ?? '')} · <button class="link" data-act="logout">Log out</button></p>
    </section>`;
  }
  return `${backLink()}${staffHtml(role)}<section class="panel account-box">
      <h2>${esc(a.display_name)}</h2>
      ${a.banned ? '<p class="error">Blocked from chat and betting.</p>' : ''}
      <div class="token-row">
        <div><span class="muted small">Tokens</span><b>${fmtTokens(a.tokens)}</b></div>
        <div><span class="muted small">In open bets</span><b>${fmtTokens(a.in_play)}</b></div>
      </div>
      <p class="muted small">+250 on ${when(a.next_topup)}</p>
      <p><a href="/my-bets/">Your bets are on GuinnessBet › My Bets</a></p>
      <p class="muted small">${esc(a.email ?? '')} · <button class="link" data-act="logout">Log out</button></p>
    </section>`;
}

async function render() {
  if (S.recovering) { app.innerHTML = recoverHtml(); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.is_anonymous) {
    S.scorer = !!session?.user?.is_anonymous;
    app.innerHTML = backLink() + formsHtml();
    return;
  }
  const [a, role] = await Promise.all([loadAccount(true), roleNow()]);
  // Fresh from the confirmation link, with somewhere to go back to.
  if (a && next && sessionStorage.getItem('uosdarts:justConfirmed')) {
    sessionStorage.removeItem('uosdarts:justConfirmed');
    location.replace(next);
    return;
  }
  app.innerHTML = accountHtml(a, session.user.email, role);
}

app.addEventListener('click', async e => {
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
      // A username (no @) is a committee login, kept under the site's own domain.
      S.email = v('email');
      const { error } = await sb.auth.signInWithPassword({ email: toLoginEmail(S.email), password: f.elements.password.value });
      if (error) {
        if (/confirm/i.test(error.message)) { S.sent = S.email; render(); return; }
        throw new Error(/invalid/i.test(error.message) ? 'Wrong email, username or password' : error.message);
      }
      if (next) { location.href = next; return; }
      const role = await roleNow();
      if (role === 'super') { location.href = '/super/'; return; }
      if (role) { location.href = '/admin/'; return; }
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
