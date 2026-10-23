import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, AUTH, post } from '../api';
import { useAuth } from '../auth';
import { Card, Field, Msg } from '../components/ui';
import { errMsg } from '../util';

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const u = await login(email, password);
      const from = (loc.state as { from?: string } | null)?.from;
      nav(from ?? (u.roles.includes('ADMIN') ? '/admin' : u.roles.includes('SELLER') ? '/seller' : '/'), { replace: true });
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Card title="Log in">
      <form className="form" onSubmit={submit}>
        <Msg error={err} />
        <Field label="Email"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
        <Field label="Password"><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
        <p><Link to="/forgot-password">Forgot password?</Link> · <Link to="/register">Create an account</Link></p>
      </form>
    </Card>
  );
}

export function Register() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api(`${AUTH}/register`, { method: 'POST', body: f, auth: false });
      await login(f.email, f.password);
      nav('/', { replace: true });
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  }
  return (
    <Card title="Create your account">
      <form className="form" onSubmit={submit}>
        <Msg error={err} />
        <Field label="Name"><input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" /></Field>
        <Field label="Password" hint="At least 10 characters"><input type="password" required minLength={10} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Sign up'}</button>
      </form>
    </Card>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api(`${AUTH}/forgot-password`, { method: 'POST', body: { email }, auth: false }); setDone(true); } catch (e2) { setErr(errMsg(e2)); }
  }
  return (
    <Card title="Reset your password">
      {done ? (
        <>
          <Msg ok="If the account exists, a reset message has been sent." />
          <p className="muted">Local dev: the reset token is printed in the auth-service log (<code>docker compose logs auth-service | grep DEV_MAIL</code>). Open <code>/reset-password?token=…</code>.</p>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <Msg error={err} />
          <Field label="Email"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <button className="btn primary">Send reset link</button>
        </form>
      )}
    </Card>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [pw, setPw] = useState('');
  const [state, setState] = useState<{ err?: string; ok?: boolean }>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api(`${AUTH}/reset-password`, { method: 'POST', body: { token, newPassword: pw }, auth: false }); setState({ ok: true }); } catch (e2) { setState({ err: errMsg(e2) }); }
  }
  return (
    <Card title="Choose a new password">
      {state.ok ? <Msg ok="Password changed. You can log in now." /> : (
        <form className="form" onSubmit={submit}>
          <Msg error={state.err} />
          <Field label="Reset token"><input required value={token} onChange={(e) => setToken(e.target.value)} /></Field>
          <Field label="New password" hint="At least 10 characters"><input type="password" required minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
          <button className="btn primary">Change password</button>
        </form>
      )}
      <p><Link to="/login">Back to login</Link></p>
    </Card>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [state, setState] = useState<{ err?: string; ok?: boolean }>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api(`${AUTH}/verify-email`, { method: 'POST', body: { token }, auth: false }); setState({ ok: true }); } catch (e2) { setState({ err: errMsg(e2) }); }
  }
  return (
    <Card title="Verify your email">
      {state.ok ? <Msg ok="Email verified." /> : (
        <form className="form" onSubmit={submit}>
          <Msg error={state.err} />
          <Field label="Verification token"><input required value={token} onChange={(e) => setToken(e.target.value)} /></Field>
          <button className="btn primary">Verify</button>
        </form>
      )}
    </Card>
  );
}

export function Account() {
  const { user, reload } = useAuth();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pwMsg, setPwMsg] = useState<{ err?: string; ok?: string }>({});
  const [store, setStore] = useState({ storeName: '', description: '' });
  const [appMsg, setAppMsg] = useState<{ err?: string; ok?: string }>({});
  const [application, setApplication] = useState<any>(undefined);

  async function loadApp() {
    try { setApplication(await api(`${AUTH}/seller/application`)); } catch { setApplication(null); }
  }
  if (application === undefined && user) void loadApp();

  async function changePw(e: FormEvent) {
    e.preventDefault();
    try { await post(`${AUTH}/change-password`, pw); setPwMsg({ ok: 'Password changed.' }); setPw({ currentPassword: '', newPassword: '' }); } catch (e2) { setPwMsg({ err: errMsg(e2) }); }
  }
  async function apply(e: FormEvent) {
    e.preventDefault();
    try { await post(`${AUTH}/apply-as-seller`, store); setAppMsg({ ok: 'Application submitted. An admin will review it.' }); await loadApp(); } catch (e2) { setAppMsg({ err: errMsg(e2) }); }
  }
  if (!user) return null;
  const isSeller = user.roles.includes('SELLER');
  return (
    <>
      <h1>My account</h1>
      <Card title="Profile">
        <p><strong>{user.name}</strong> · {user.email}</p>
        <p className="muted">Roles: {user.roles.join(', ')} · Email verified: {user.emailVerified ? 'yes' : 'no'}</p>
      </Card>
      {!isSeller && (
        <Card title="Become a seller">
          {application?.status === 'PENDING' && <Msg ok={`Application for “${application.storeName}” is pending review.`} />}
          {application?.status === 'REJECTED' && <Msg error={`Your last application was rejected: ${application.rejectionReason ?? ''}`} />}
          {application?.status === 'APPROVED' && (
            <><Msg ok="Approved! Refresh your session to get seller access." /><button className="btn primary" onClick={() => reload()}>Refresh my session</button></>
          )}
          {application?.status !== 'PENDING' && application?.status !== 'APPROVED' && (
            <form className="form" onSubmit={apply}>
              <Msg error={appMsg.err} ok={appMsg.ok} />
              <Field label="Store name"><input required minLength={2} maxLength={100} value={store.storeName} onChange={(e) => setStore({ ...store, storeName: e.target.value })} /></Field>
              <Field label="Description"><textarea maxLength={1000} value={store.description} onChange={(e) => setStore({ ...store, description: e.target.value })} /></Field>
              <button className="btn primary">Apply</button>
            </form>
          )}
        </Card>
      )}
      <Card title="Change password">
        <form className="form" onSubmit={changePw}>
          <Msg error={pwMsg.err} ok={pwMsg.ok} />
          <Field label="Current password"><input type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password"><input type="password" required minLength={10} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <button className="btn">Change password</button>
        </form>
      </Card>
    </>
  );
}
