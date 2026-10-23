import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, adminLogin, PASSWORD, registerAndLogin, uniqueEmail, verifyJwtWithJwks } from './helpers.mjs';

test('register: duplicate email rejected, hash never returned', async () => {
  const email = uniqueEmail('dup');
  const first = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, name: 'A' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.passwordHash, undefined);
  const dup = await api('/api/auth/register', { method: 'POST', body: { email: email.toUpperCase(), password: PASSWORD, name: 'B' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CONFLICT');
});

test('register validation: short password and client-supplied roles rejected', async () => {
  const short = await api('/api/auth/register', { method: 'POST', body: { email: uniqueEmail(), password: 'short', name: 'A' } });
  assert.equal(short.status, 400);
  const extra = await api('/api/auth/register', { method: 'POST', body: { email: uniqueEmail(), password: PASSWORD, name: 'A', roles: ['ADMIN'] } });
  assert.equal(extra.status, 400, 'roles cannot be supplied by the client');
});

test('login: wrong password 401, access token verifies against JWKS', async () => {
  const u = await registerAndLogin('login');
  const bad = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: 'wrong-password-123' } });
  assert.equal(bad.status, 401);
  const jwks = (await api('/api/auth/.well-known/jwks.json')).body;
  const claims = verifyJwtWithJwks(u.accessToken, jwks);
  assert.ok(claims, 'signature valid');
  assert.equal(claims.sub, u.user.id);
  assert.deepEqual(claims.roles, ['CUSTOMER']);
  assert.equal(claims.iss, 'mve-auth');
  assert.equal(claims.aud, 'mve-api');
  assert.ok(claims.exp > claims.iat);
});

test('invalid and tampered tokens rejected', async () => {
  assert.equal((await api('/api/auth/profile')).status, 401);
  assert.equal((await api('/api/auth/profile', { token: 'not.a.jwt' })).status, 401);
  const u = await registerAndLogin('tamper');
  const [h, , s] = u.accessToken.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: u.user.id, roles: ['ADMIN'], iss: 'mve-auth', aud: 'mve-api', exp: 9999999999 })).toString('base64url');
  assert.equal((await api('/api/auth/profile', { token: `${h}.${forged}.${s}` })).status, 401);
});

test('refresh rotation: reuse of a rotated token revokes the family', async () => {
  const u = await registerAndLogin('refresh');
  const r1 = await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, u.refreshToken);
  const replay = await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } });
  assert.equal(replay.status, 401);
  const afterTheft = await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: r1.body.refreshToken } });
  assert.equal(afterTheft.status, 401, 'descendant token revoked after reuse detected');
});

test('logout revokes the refresh token', async () => {
  const u = await registerAndLogin('logout');
  assert.equal((await api('/api/auth/logout', { method: 'POST', body: { refreshToken: u.refreshToken } })).status, 204);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } })).status, 401);
});

test('refresh cookie is HttpOnly and SameSite=Lax', async () => {
  const email = uniqueEmail('cookie');
  await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, name: 'C' } });
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /refresh_token=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
});

test('change password revokes sessions and requires current password', async () => {
  const u = await registerAndLogin('chpw');
  const bad = await api('/api/auth/change-password', { method: 'POST', token: u.accessToken, body: { currentPassword: 'nope-nope-nope', newPassword: 'Another-Pass-12345' } });
  assert.equal(bad.status, 401);
  const ok = await api('/api/auth/change-password', { method: 'POST', token: u.accessToken, body: { currentPassword: PASSWORD, newPassword: 'Another-Pass-12345' } });
  assert.equal(ok.status, 204);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: u.refreshToken } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: 'Another-Pass-12345' } })).status, 200);
});

test('forgot-password does not reveal whether an account exists; bad reset token rejected', async () => {
  const known = await registerAndLogin('forgot');
  const a = await api('/api/auth/forgot-password', { method: 'POST', body: { email: known.email } });
  const b = await api('/api/auth/forgot-password', { method: 'POST', body: { email: uniqueEmail('ghost') } });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(a.body, b.body);
  const bad = await api('/api/auth/reset-password', { method: 'POST', body: { token: 'x'.repeat(30), newPassword: PASSWORD } });
  assert.equal(bad.status, 401);
});

test('admin-only routes reject anonymous and non-admin callers', async () => {
  const customer = await registerAndLogin('plain');
  for (const path of ['/api/auth/admin/users', '/api/auth/admin/seller-applications', '/api/auth/admin/audit', '/api/auth/admin/stores']) {
    assert.equal((await api(path)).status, 401, path);
    assert.equal((await api(path, { token: customer.accessToken })).status, 403, path);
  }
  const admin = await adminLogin();
  const users = await api('/api/auth/admin/users?size=5', { token: admin.accessToken });
  assert.equal(users.status, 200);
  assert.ok(users.body.items.every((x) => x.passwordHash === undefined));
});

test('seller onboarding: apply, approve (idempotent), token carries store, suspend removes it', async () => {
  const admin = await adminLogin();
  const u = await registerAndLogin('seller');
  const app = await api('/api/auth/apply-as-seller', { method: 'POST', token: u.accessToken, body: { storeName: 'E2E Store', description: 'test' } });
  assert.equal(app.status, 201);
  assert.equal((await api('/api/auth/apply-as-seller', { method: 'POST', token: u.accessToken, body: { storeName: 'Again' } })).status, 409);

  const approvePath = `/api/auth/admin/seller-applications/${app.body._id}/approve`;
  assert.equal((await api(approvePath, { method: 'POST', token: u.accessToken })).status, 403);

  const a1 = await api(approvePath, { method: 'POST', token: admin.accessToken });
  const a2 = await api(approvePath, { method: 'POST', token: admin.accessToken });
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200);
  assert.equal(a1.body._id, a2.body._id, 'one store regardless of repeated approval');

  const relog = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } });
  assert.ok(relog.body.user.roles.includes('SELLER'));
  const jwks = (await api('/api/auth/.well-known/jwks.json')).body;
  assert.equal(verifyJwtWithJwks(relog.body.accessToken, jwks).storeId, a1.body._id);

  const rej = await api(`/api/auth/admin/seller-applications/${app.body._id}/reject`, { method: 'POST', token: admin.accessToken, body: { reason: 'late' } });
  assert.equal(rej.status, 409, 'cannot reject an approved application');

  await api(`/api/auth/admin/stores/${a1.body._id}/status`, { method: 'POST', token: admin.accessToken, body: { status: 'SUSPENDED' } });
  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: { refreshToken: relog.body.refreshToken } })).status, 401);
  const after = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } });
  assert.equal(verifyJwtWithJwks(after.body.accessToken, jwks).storeId, undefined, 'suspended store id not issued');
  assert.equal((await api(`/api/auth/stores/${a1.body._id}`)).status, 404);

  const audit = await api('/api/auth/admin/audit?size=50', { token: admin.accessToken });
  assert.ok(audit.body.items.some((e) => e.action === 'SELLER_APPROVED' && e.targetId === app.body._id));
});

test('disabled user cannot log in', async () => {
  const admin = await adminLogin();
  const u = await registerAndLogin('disabled');
  const res = await api(`/api/auth/admin/users/${u.user.id}/status`, { method: 'POST', token: admin.accessToken, body: { status: 'DISABLED' } });
  assert.equal(res.status, 200);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: PASSWORD } })).status, 403);
});

test('error envelope carries a request id and no stack trace', async () => {
  const admin = await adminLogin();
  const res = await api('/api/auth/admin/users/not-a-uuid/status', { method: 'POST', token: admin.accessToken, body: { status: 'ACTIVE' } });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.requestId);
  assert.ok(!JSON.stringify(res.body).includes(' at '));
});
