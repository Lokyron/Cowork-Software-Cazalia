// Vérification d'adresse e-mail : jetons, routes, blocage des réservations.
//
// Les deux tests les plus importants : un membre NON vérifié ne peut ni poser de
// verrou de panier ni lancer un checkout (EMAIL_NON_VERIFIE), et le mode admin
// n'est jamais bloqué.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-emailverif-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

// `lib/cart.js` importe le SDK Stripe. Si le paquet n'est pas installé sur la machine
// (cas du poste de développement, où `npm install` est proscrit), on le remplace par
// une doublure vide : ces tests n'appellent jamais Stripe (le contrôle d'e-mail
// précède tout paiement). Quand le paquet est présent, le vrai SDK est utilisé.
try {
  await import('stripe');
} catch {
  const { register } = await import('node:module');
  const hooks = `export async function resolve(spec, ctx, next) {
    if (spec === 'stripe') return { url: 'data:text/javascript,export default class Stripe {}', shortCircuit: true };
    return next(spec, ctx);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { hashPassword } = await import('../src/auth.js');
const V = await import('../src/lib/emailVerification.js');
const { addHold, startBookingCheckout } = await import('../src/lib/cart.js');
const { updateOwnProfile, adminCreateUser } = await import('../src/lib/users.js');
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { attachUser } = await import('../src/middleware.js');
const { authRouter } = await import('../src/routes/auth.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

let seq = 0;
/** Crée un compte directement en base. */
function makeUser({ verified = 0, role = 'member' } = {}) {
  seq += 1;
  return Number(db.prepare(
    `INSERT INTO users (email, display_name, first_name, last_name, phone, password_hash, role, email_verified)
     VALUES (?, ?, 'Prénom', 'Nom', '0600000000', ?, ?, ?)`
  ).run(`user${seq}@exemple.test`, `Prénom Nom ${seq}`, hashPassword('Zx9!kLm2#Qw4pR'), role, verified).lastInsertRowid);
}
const isVerified = (id) => db.prepare(`SELECT email_verified FROM users WHERE id = ?`).get(id).email_verified;
const code = (c) => (e) => e.code === c;

// Salle de réunion réservable en ligne (tarif horaire), créneau futur dans les horaires (mercredi 13/01/2027, 9h-10h Paris).
const spaceId = Number(db.prepare(
  `INSERT INTO spaces (name, kind, category, online_bookable, exclusive, capacity, credits_per_hour)
   VALUES ('Salle test', 'room', 'MEETING_ROOM', 1, 1, 8, 1)`
).run().lastInsertRowid);
// Salle exclusive : un créneau distinct par test (n = 0..8) pour ne pas se heurter entre eux.
const slot = (n) => [`2027-01-13T${String(8 + n).padStart(2, '0')}:00:00.000Z`, `2027-01-13T${String(9 + n).padStart(2, '0')}:00:00.000Z`];
const [START, END] = slot(0);
const holdCount = (uid) => db.prepare(`SELECT COUNT(*) AS n FROM reservation_holds WHERE user_id = ?`).get(uid).n;

// ── Jetons ───────────────────────────────────────────────────────────────────

test('le jeton est stocké en empreinte sha256, jamais en clair', () => {
  const uid = makeUser();
  const { token } = V.createVerificationToken(uid);
  assert.match(token, /^[0-9a-f]{64}$/);
  const rows = db.prepare(`SELECT token FROM email_verifications WHERE user_id = ?`).all(uid);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].token.startsWith('sha256:'));
  assert.notEqual(rows[0].token, token);
  assert.ok(!rows[0].token.includes(token));
  // Une valeur lue en base ne sert PAS de jeton.
  assert.equal(V.getVerificationInfo(rows[0].token), null);
  assert.throws(() => V.consumeVerificationToken(rows[0].token), code('TOKEN_INVALIDE'));
  assert.ok(V.getVerificationInfo(token));
});

test('jeton inconnu, expiré ou déjà consommé : refusé', () => {
  const uid = makeUser();
  assert.throws(() => V.consumeVerificationToken('inconnu'), code('TOKEN_INVALIDE'));
  assert.throws(() => V.consumeVerificationToken(''), code('TOKEN_INVALIDE'));

  const { token: expired } = V.createVerificationToken(uid);
  db.prepare(`UPDATE email_verifications SET expires_at = ? WHERE user_id = ?`).run('2000-01-01T00:00:00.000Z', uid);
  assert.equal(V.getVerificationInfo(expired), null);
  assert.throws(() => V.consumeVerificationToken(expired), code('TOKEN_INVALIDE'));
  assert.equal(isVerified(uid), 0);

  const { token } = V.createVerificationToken(uid);
  V.consumeVerificationToken(token);
  assert.throws(() => V.consumeVerificationToken(token), code('TOKEN_INVALIDE')); // usage unique
  assert.equal(V.getVerificationInfo(token), null);
});

test('une nouvelle demande invalide le jeton précédent', () => {
  const uid = makeUser();
  const first = V.createVerificationToken(uid).token;
  const second = V.createVerificationToken(uid).token;
  assert.notEqual(first, second);
  assert.equal(V.getVerificationInfo(first), null);
  assert.throws(() => V.consumeVerificationToken(first), code('TOKEN_INVALIDE'));
  assert.ok(V.getVerificationInfo(second));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ? AND used_at IS NULL`).get(uid).n, 1);
});

test('la durée de vie par défaut du jeton est de 7 jours', () => {
  assert.equal(config.emailVerifyTokenTtlMs, 7 * 24 * 3600 * 1000);
  const uid = makeUser();
  const { expiresAt } = V.createVerificationToken(uid);
  const ttl = new Date(expiresAt).getTime() - Date.now();
  assert.ok(Math.abs(ttl - 7 * 24 * 3600 * 1000) < 5000);
});

// ── Blocage des réservations (serveur) ───────────────────────────────────────

test('membre NON vérifié : impossible de poser un verrou de panier', () => {
  const uid = makeUser({ verified: 0 });
  assert.throws(() => addHold(uid, spaceId, START, END, 1, { tarifType: 'heure' }), code('EMAIL_NON_VERIFIE'));
  assert.equal(holdCount(uid), 0);
});

test('membre NON vérifié : impossible de lancer un checkout (avant tout paiement)', async () => {
  const uid = makeUser({ verified: 0 });
  // Verrou posé AVANT que l'état change (vérifié puis repassé non vérifié) : le checkout doit refuser.
  db.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).run(uid);
  addHold(uid, spaceId, START, END, 1, { tarifType: 'heure' });
  db.prepare(`UPDATE users SET email_verified = 0 WHERE id = ?`).run(uid);
  await assert.rejects(startBookingCheckout(uid, 'https://exemple.test'), code('EMAIL_NON_VERIFIE'));
  // Même sans panier : le refus passe avant PANIER_VIDE.
  const other = makeUser({ verified: 0 });
  await assert.rejects(startBookingCheckout(other, 'https://exemple.test'), code('EMAIL_NON_VERIFIE'));
});

test('membre vérifié : le verrou est posé, et le checkout n\'est pas refusé pour ce motif', async () => {
  const uid = makeUser({ verified: 1 });
  const hold = addHold(uid, spaceId, ...slot(1), 1, { tarifType: 'heure' });
  assert.ok(hold.id);
  assert.equal(holdCount(uid), 1);
  const empty = makeUser({ verified: 1 });
  await assert.rejects(startBookingCheckout(empty, 'https://exemple.test'), code('PANIER_VIDE'));
});

test('MODE ADMIN : jamais bloqué par l\'état de vérification du membre', () => {
  const uid = makeUser({ verified: 0 });
  const hold = addHold(uid, spaceId, ...slot(2), 1, { tarifType: 'heure', adminMode: true, customCostCents: 0, createdBy: 1 });
  assert.ok(hold.id);
  assert.equal(hold.payment_method, 'FREE_ADMIN');
  assert.equal(isVerified(uid), 0); // l'état du membre n'a pas été touché
});

test('un compte de rôle admin n\'est pas bloqué par la règle', () => {
  const adminId = makeUser({ verified: 0, role: 'admin' });
  assert.doesNotThrow(() => V.assertCanBook(adminId));
});

// ── Profil / comptes admin ───────────────────────────────────────────────────

test('changer d\'adresse e-mail repasse email_verified à 0 ; enregistrer sans toucher à l\'e-mail ne change rien', () => {
  const uid = makeUser({ verified: 1 });
  const email = db.prepare(`SELECT email FROM users WHERE id = ?`).get(uid).email;
  updateOwnProfile(uid, { phone: '0611111111' });
  assert.equal(isVerified(uid), 1);
  updateOwnProfile(uid, { email: email.toUpperCase() }); // même adresse (casse) : pas un changement
  assert.equal(isVerified(uid), 1);
  const profile = updateOwnProfile(uid, { email: 'autre.adresse@exemple.test' });
  assert.equal(profile.email_verified, false);
  assert.equal(isVerified(uid), 0);
});

test('compte créé par l\'administrateur : vérifié d\'emblée', () => {
  const { user } = adminCreateUser({ first_name: 'A', last_name: 'B', email: 'cree.par.admin@exemple.test', phone: '0600000000' });
  assert.equal(isVerified(user.id), 1);
  assert.equal(user.email_verified, true);
});

test('la suppression d\'un compte supprime aussi ses jetons de vérification', async () => {
  const { deleteUserAccount } = await import('../src/lib/users.js');
  const uid = makeUser();
  V.createVerificationToken(uid);
  assert.doesNotThrow(() => deleteUserAccount(uid));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(uid).n, 0);
});

// ── Routes HTTP ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(attachUser);
app.use('/api/auth', authRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/auth`;
test.after(() => { server.close(); });

async function call(method, url, body, cookie) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}
const sessionCookie = (uid) => {
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).run(id, uid, new Date(Date.now() + 3600e3).toISOString());
  return `${config.cookieName}=${id}`;
};

test('POST /verify-email passe email_verified à 1 ; GET /verify-email/:token valide sans consommer', async () => {
  const uid = makeUser();
  const { token } = V.createVerificationToken(uid);
  const check = await call('GET', `/verify-email/${token}`);
  assert.equal(check.status, 200);
  assert.equal(check.json.valid, true);
  assert.equal(isVerified(uid), 0); // la lecture ne consomme pas
  const ok = await call('POST', '/verify-email', { token });
  assert.equal(ok.status, 200);
  assert.equal(isVerified(uid), 1);
  // Jeton rejoué, visiteur anonyme : refus neutre. Jeton inconnu : idem.
  assert.equal((await call('POST', '/verify-email', { token })).status, 400);
  assert.equal((await call('GET', '/verify-email/inconnu')).status, 400);
  // Même réponse pour un jeton rejoué par le membre connecté déjà vérifié : pas d'alerte.
  const again = await call('POST', '/verify-email', { token }, sessionCookie(uid));
  assert.equal(again.status, 200);
  assert.equal(again.json.ok, true);
});

test('POST /resend-verification : exige une session, invalide l\'ancien lien, neutre si déjà vérifié', async () => {
  assert.equal((await call('POST', '/resend-verification')).status, 401);
  const uid = makeUser();
  const { token: old } = V.createVerificationToken(uid);
  const r = await call('POST', '/resend-verification', null, sessionCookie(uid));
  // Aucun fournisseur d'e-mail en test : l'envoi échoue et le renvoi le dit (503).
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'EMAIL_ENVOI_IMPOSSIBLE');
  assert.equal(V.getVerificationInfo(old), null); // l'ancien lien est invalidé
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ? AND used_at IS NULL`).get(uid).n, 1);

  const verified = makeUser({ verified: 1 });
  const before = db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(verified).n;
  const r2 = await call('POST', '/resend-verification', null, sessionCookie(verified));
  assert.deepEqual(r2.json, { ok: true });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(verified).n, before);
});

test('inscription : connecté tout de suite, non vérifié, e-mail tenté ; /me expose email_verified', async () => {
  const r = await call('POST', '/register', {
    email: 'inscrit@exemple.test', first_name: 'Ins', last_name: 'Crit', phone: '0600000000',
    password: 'Zx9!kLm2#Qw4pR', cgu_accepted: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.email_verified, false);
  const cookie = r.setCookie.split(';')[0];
  const me = await call('GET', '/me', null, cookie);
  assert.equal(me.json.user.email, 'inscrit@exemple.test');
  assert.equal(me.json.user.email_verified, false);
  const uid = me.json.user.id;
  assert.equal(isVerified(uid), 0);
  // Jeton émis (en empreinte) et envoi tenté (journalisé, ici « skipped » car aucun SMTP en test).
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(uid).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE template_code = 'email_verification' AND to_email = ?`).get('inscrit@exemple.test').n, 1);
  // Et le blocage s'applique à ce compte neuf.
  assert.throws(() => addHold(uid, spaceId, START, END, 1, { tarifType: 'heure' }), code('EMAIL_NON_VERIFIE'));
});

test('inscription : une panne de la vérification ne fait JAMAIS échouer l\'inscription', async () => {
  db.exec(`ALTER TABLE email_verifications RENAME TO email_verifications_hs`);
  try {
    const r = await call('POST', '/register', {
      email: 'panne@exemple.test', first_name: 'Pa', last_name: 'Nne', phone: '0600000000',
      password: 'Zx9!kLm2#Qw4pR', cgu_accepted: true,
    });
    assert.equal(r.status, 201);
    assert.ok(r.setCookie);
  } finally {
    db.exec(`ALTER TABLE email_verifications_hs RENAME TO email_verifications`);
  }
});

test('PATCH /me : un vrai changement d\'e-mail repasse en non vérifié et émet un nouveau lien', async () => {
  const uid = makeUser({ verified: 1 });
  const cookie = sessionCookie(uid);
  const same = await call('PATCH', '/me', { phone: '0622222222' }, cookie);
  assert.equal(same.status, 200);
  assert.equal(isVerified(uid), 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(uid).n, 0);
  const changed = await call('PATCH', '/me', { email: 'nouvelle@exemple.test' }, cookie);
  assert.equal(changed.status, 200);
  assert.equal(isVerified(uid), 0);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ?`).get(uid).n, 1);
});

test('EMAIL_NON_VERIFIE est traduit en 403 (et non journalisé comme erreur inattendue)', async () => {
  const { sendBusinessError } = await import('../src/middleware.js');
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  sendBusinessError(res, Object.assign(new Error('EMAIL_NON_VERIFIE'), { code: 'EMAIL_NON_VERIFIE' }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'EMAIL_NON_VERIFIE');
});

// ── Renvoi : l'échec d'envoi remonte ; recours administrateur ────────────────

test('POST /resend-verification : EMAIL_ENVOI_IMPOSSIBLE (503) quand le courrier ne part pas, {ok:true} quand il part', async () => {
  const uid = makeUser();
  const cookie = sessionCookie(uid);
  // Aucun fournisseur configuré en test : le mailer renvoie { sent:false }.
  const ko = await call('POST', '/resend-verification', null, cookie);
  assert.equal(ko.status, 503);
  assert.equal(ko.json.error, 'EMAIL_ENVOI_IMPOSSIBLE');
  // Envoi réussi : fournisseur SMTP configuré et transport simulé qui accepte le message.
  const { default: nodemailer } = await import('nodemailer');
  const { setSetting } = await import('../src/lib/settings.js');
  const orig = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: '<ok@test>' }) });
  try {
    setSetting('smtp', { host: 'smtp.exemple.test', port: 587, from_email: 'no-reply@exemple.test' });
    const ok = await call('POST', '/resend-verification', null, cookie);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true });
  } finally {
    nodemailer.createTransport = orig;
    db.prepare(`DELETE FROM app_settings WHERE key = 'smtp'`).run();
  }
});

test('POST /resend-verification : compte déjà vérifié => 200 neutre, aucun envoi, aucune erreur', async () => {
  const verified = makeUser({ verified: 1 });
  const before = db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n;
  const r = await call('POST', '/resend-verification', null, sessionCookie(verified));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_log`).get().n, before);
});

test('inscription : réussit (201 + cookie) même quand l\'envoi de l\'e-mail échoue', async () => {
  // Aucun SMTP configuré : le courrier ne part pas, l'inscription réussit quand même.
  const r = await call('POST', '/register', {
    email: 'sans.smtp@exemple.test', first_name: 'Sans', last_name: 'Smtp', phone: '0600000000',
    password: 'Zx9!kLm2#Qw4pR', cgu_accepted: true,
  });
  assert.equal(r.status, 201);
  assert.ok(r.setCookie);
});

test('route admin POST /users/:id/verify-email : passe email_verified à 1 ; refus pour un non-admin', async () => {
  const { adminRouter } = await import('../src/routes/admin.js');
  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use(cookieParser());
  adminApp.use(attachUser);
  adminApp.use('/api/admin', adminRouter);
  const srv = await new Promise((resolve) => { const s = adminApp.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = (id) => `http://127.0.0.1:${srv.address().port}/api/admin/users/${id}/verify-email`;
    const target = makeUser({ verified: 0 });
    V.createVerificationToken(target);
    const adminCookie = sessionCookie(makeUser({ verified: 1, role: 'admin' }));
    const memberCookie = sessionCookie(makeUser({ verified: 1 }));

    const anon = await fetch(url(target), { method: 'POST' });
    assert.equal(anon.status, 401);
    const asMember = await fetch(url(target), { method: 'POST', headers: { cookie: memberCookie } });
    assert.equal(asMember.status, 403);
    assert.equal(isVerified(target), 0);

    const ok = await fetch(url(target), { method: 'POST', headers: { cookie: adminCookie } });
    assert.equal(ok.status, 200);
    assert.equal(isVerified(target), 1);
    // Les liens en attente sont invalidés.
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ? AND used_at IS NULL`).get(target).n, 0);

    const missing = await fetch(url(999999), { method: 'POST', headers: { cookie: adminCookie } });
    assert.equal(missing.status, 404);
  } finally {
    srv.close();
  }
});
