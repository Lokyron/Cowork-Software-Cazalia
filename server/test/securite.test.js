// Tests de non-régression SÉCURITÉ.
//
// Chaque cas correspond à une vulnérabilité corrigée lors de l'audit : le test
// échoue si la protection est retirée ou contournée. Exécution :
//   npm test          (depuis server/)
//
// La base de test est créée dans un fichier temporaire — jamais la base de
// production : `DB_PATH` est positionné AVANT le premier import de `db.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-test-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
// Coût scrypt réduit pour la suite de tests : on vérifie le FORMAT et la
// compatibilité ascendante, pas la dureté du paramétrage de production.
process.env.SCRYPT_N = '16384';

const { hashPassword, verifyPassword, needsRehash, fakeVerify } = await import('../src/auth.js');
const { assertStrongPassword, createResetToken, consumeResetToken, getResetTokenInfo } =
  await import('../src/lib/passwords.js');
const { escapeHtml, headerSafe } = await import('../src/lib/html.js');
const { interpolate, interpolateText } = await import('../src/lib/mailer.js');
const { exportCsv, createProspect } = await import('../src/lib/prospects.js');
const { sealSecret, openSecret, generateSecret, verifyToken } = await import('../src/lib/twofactor.js');
const { parsePeriod } = await import('../src/lib/time.js');
const { securityHeaders, rateLimit, sameOriginGuard } = await import('../src/security.js');
const { adminUpdateUser, adminCreateUser, deleteUserAccount } = await import('../src/lib/users.js');
const { reserveBatch } = await import('../src/lib/booking.js');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); });

// ── Doublures HTTP minimales (aucun serveur n'est démarré) ──────────────────

/** @returns {object} Réponse Express simulée, exposant ce qui a été émis. */
function fakeRes() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/**
 * @param {object} [opts] Méthode, en-têtes et adresse IP de la requête simulée.
 * @returns {object} Requête Express simulée.
 */
function fakeReq({ method = 'POST', headers = {}, ip = '10.0.0.1', secure = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, ip, secure, get: (h) => lower[h.toLowerCase()] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hachage des mots de passe (CWE-916, CWE-208)
// ─────────────────────────────────────────────────────────────────────────────

test('le hachage embarque ses paramètres et vérifie correctement', () => {
  const hash = hashPassword('Correct-Horse-42');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('Correct-Horse-42', hash), true);
  assert.equal(verifyPassword('Correct-Horse-43', hash), false);
});

test('deux hachages du même mot de passe diffèrent (sel aléatoire)', () => {
  assert.notEqual(hashPassword('Correct-Horse-42'), hashPassword('Correct-Horse-42'));
});

test('les empreintes au format historique restent vérifiables', () => {
  const salt = crypto.randomBytes(16);
  const legacy = `${salt.toString('hex')}:${crypto.scryptSync('AncienMotDePasse!1', salt, 64).toString('hex')}`;
  assert.equal(verifyPassword('AncienMotDePasse!1', legacy), true);
  assert.equal(verifyPassword('autre', legacy), false);
});

test('une empreinte au coût inférieur est signalée pour recalcul', () => {
  const salt = crypto.randomBytes(16);
  const legacy = `${salt.toString('hex')}:${crypto.scryptSync('x', salt, 64).toString('hex')}`;
  assert.equal(needsRehash(legacy), false); // SCRYPT_N=16384 en test : même coût
  assert.equal(needsRehash('valeur-corrompue'), true);
});

test('un mot de passe démesuré est rejeté au lieu d’être haché (anti-DoS)', () => {
  assert.throws(() => hashPassword('a'.repeat(5000)), /MOT_DE_PASSE_INVALIDE/);
  assert.equal(verifyPassword('a'.repeat(5000), hashPassword('Correct-Horse-42')), false);
});

test('la vérification factice ne lève pas et renvoie toujours faux', () => {
  assert.equal(fakeVerify('peu importe'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Politique de mot de passe (CWE-521)
// ─────────────────────────────────────────────────────────────────────────────

test('la politique refuse les mots de passe faibles', () => {
  for (const faible of ['court1!', '12345678', 'azertyuiop', 'Password', 'aaaaaaaaaaaa', 'Azerty2024']) {
    assert.throws(() => assertStrongPassword(faible), /MOT_DE_PASSE_FAIBLE/, `accepté à tort : ${faible}`);
  }
});

test('la politique accepte un mot de passe robuste', () => {
  for (const bon of ['Coworking-Boutonnet-2026', 'Tr0ub4dour&3xtra', 'jeVeuxUnBureau!7']) {
    assert.doesNotThrow(() => assertStrongPassword(bon), `refusé à tort : ${bon}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Jetons de réinitialisation (CWE-522)
// ─────────────────────────────────────────────────────────────────────────────

test('le jeton de réinitialisation n’est jamais stocké en clair', () => {
  const { user } = adminCreateUser({
    first_name: 'Reset', last_name: 'Test', email: 'reset@test.local', phone: '0600000001',
  });
  const { token } = createResetToken(user.id, null);

  const enBase = db.prepare(`SELECT token FROM password_resets WHERE user_id = ?`).get(user.id);
  assert.notEqual(enBase.token, token, 'le jeton en clair est stocké tel quel');
  assert.equal(enBase.token, `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`);

  // Le jeton en clair reste exploitable côté client…
  assert.ok(getResetTokenInfo(token));
  // …mais la valeur STOCKÉE ne permet pas, elle, de rejouer la réinitialisation :
  // c'est précisément ce que protège le hachage face à une lecture de la base.
  assert.equal(getResetTokenInfo(enBase.token), null);
});

test('un jeton de réinitialisation ne sert qu’une fois', () => {
  const { user } = adminCreateUser({
    first_name: 'Once', last_name: 'Test', email: 'once@test.local', phone: '0600000002',
  });
  const { token } = createResetToken(user.id, null);
  consumeResetToken(token, 'Nouveau-Mot-2026!');
  assert.throws(() => consumeResetToken(token, 'Encore-Un-Autre-9!'), /TOKEN_INVALIDE/);
  assert.equal(getResetTokenInfo(token), null);
  const ligne = db.prepare(`SELECT used_at FROM password_resets WHERE user_id = ?`).get(user.id);
  assert.ok(ligne.used_at, 'le jeton n’a pas été marqué comme consommé');
});

test('émettre un nouveau jeton invalide le précédent', () => {
  const { user } = adminCreateUser({
    first_name: 'Rotate', last_name: 'Test', email: 'rotate@test.local', phone: '0600000003',
  });
  const premier = createResetToken(user.id, null).token;
  createResetToken(user.id, null);
  assert.equal(getResetTokenInfo(premier), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection HTML dans les e-mails (CWE-79 / CWE-116)
// ─────────────────────────────────────────────────────────────────────────────

test('les variables de gabarit sont échappées', () => {
  const rendu = interpolate('<p>Bonjour {{client_name}}</p>', {
    client_name: '<a href="https://pirate.example">Cliquez ici</a>',
  });
  assert.ok(!rendu.includes('<a href'), 'balise injectée dans le corps de l’e-mail');
  assert.ok(rendu.includes('&lt;a href'));
});

test('une variable explicitement marquée « raw » n’est pas échappée', () => {
  const rendu = interpolate('{{bloc}}', { bloc: '<b>ok</b>' }, { raw: ['bloc'] });
  assert.equal(rendu, '<b>ok</b>');
});

test('le sujet n’est pas échappé mais reste sur une seule ligne', () => {
  const sujet = interpolateText('Réservation {{space}}', { space: 'Focus & Co\r\nBcc: pirate@example.com' });
  assert.ok(sujet.includes('&'), 'le sujet ne doit pas être encodé en entités HTML');
  assert.ok(!/[\r\n]/.test(sujet), 'injection d’en-tête SMTP possible');
});

test('escapeHtml et headerSafe couvrent les caractères significatifs', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(headerSafe('a\r\nb'), 'a b');
});

// ─────────────────────────────────────────────────────────────────────────────
// Injection de formule CSV (CWE-1236)
// ─────────────────────────────────────────────────────────────────────────────

test('l’export CSV neutralise les cellules interprétables comme formules', () => {
  createProspect({
    first_name: `=cmd|'/c calc'!A1`, last_name: '+SUM(A1)', email: 'formule@test.local',
    phone: '0612345678', consent: true,
  });
  const csv = exportCsv();
  const ligne = csv.split('\r\n').find((l) => l.includes('formule@test.local'));
  assert.ok(ligne, 'ligne absente de l’export');
  assert.ok(!/(^|;)=/.test(ligne), 'cellule commençant par « = » laissée telle quelle');
  assert.ok(!/(^|;)\+/.test(ligne), 'cellule commençant par « + » laissée telle quelle');
  assert.ok(ligne.includes(`'=cmd`) || ligne.includes(`"'=cmd`));
});

// ─────────────────────────────────────────────────────────────────────────────
// Secret TOTP chiffré au repos (CWE-312)
// ─────────────────────────────────────────────────────────────────────────────

test('le secret TOTP est chiffré au repos et reste vérifiable', () => {
  const secret = generateSecret();
  const scelle = sealSecret(secret);
  assert.ok(scelle.startsWith('enc:v1:'), 'secret stocké en clair');
  assert.notEqual(scelle, secret);
  assert.equal(openSecret(scelle), secret);
  // Un secret historique en clair reste accepté (migration sans rupture).
  assert.equal(openSecret(secret), secret);
  assert.equal(verifyToken('000000', scelle), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation des périodes de relevé (CWE-20)
// ─────────────────────────────────────────────────────────────────────────────

test('une période invalide est rejetée avant toute génération de PDF', () => {
  for (const [from, to] of [
    [undefined, undefined], ['pas-une-date', '2026-01-01'], ['2026-02-01', '2026-01-01'],
    ['2026-01-01', '2026-01-01'], ['2020-01-01', '2030-01-01'],
  ]) {
    assert.throws(() => parsePeriod(from, to), /PERIODE_INVALIDE/, `accepté à tort : ${from} → ${to}`);
  }
});

test('une période valide est normalisée en UTC', () => {
  const { fromIso, toIso } = parsePeriod('2026-01-01', '2026-02-01');
  assert.equal(fromIso, '2026-01-01T00:00:00.000Z');
  assert.equal(toIso, '2026-02-01T00:00:00.000Z');
});

// ─────────────────────────────────────────────────────────────────────────────
// En-têtes de sécurité (CWE-693, CWE-1021)
// ─────────────────────────────────────────────────────────────────────────────

test('les en-têtes de sécurité sont posés sur chaque réponse', () => {
  const res = fakeRes();
  securityHeaders(fakeReq({ method: 'GET' }), res, () => {});
  for (const h of ['content-security-policy', 'x-content-type-options', 'x-frame-options',
    'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) {
    assert.ok(res.headers[h], `en-tête manquant : ${h}`);
  }
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['content-security-policy'], /object-src 'none'/);
});

test('HSTS n’est émis qu’en HTTPS', () => {
  const clair = fakeRes();
  securityHeaders(fakeReq({ method: 'GET', secure: false }), clair, () => {});
  assert.equal(clair.headers['strict-transport-security'], undefined);

  const tls = fakeRes();
  securityHeaders(fakeReq({ method: 'GET', secure: true }), tls, () => {});
  assert.match(tls.headers['strict-transport-security'], /max-age=31536000/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Limitation de débit (CWE-307, CWE-770)
// ─────────────────────────────────────────────────────────────────────────────

test('le limiteur bloque au-delà du seuil et renvoie Retry-After', () => {
  const limiteur = rateLimit({ windowMs: 60_000, max: 3 });
  const req = fakeReq({ ip: '203.0.113.7' });
  let passages = 0;
  let res;
  for (let i = 0; i < 5; i++) {
    res = fakeRes();
    limiteur(req, res, () => { passages++; });
  }
  assert.equal(passages, 3);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'TROP_DE_TENTATIVES');
  assert.ok(Number(res.headers['retry-after']) > 0);
});

test('le limiteur compte séparément chaque adresse IP', () => {
  const limiteur = rateLimit({ windowMs: 60_000, max: 1 });
  let passages = 0;
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
    limiteur(fakeReq({ ip }), fakeRes(), () => { passages++; });
  }
  assert.equal(passages, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Garde anti-CSRF (CWE-352)
// ─────────────────────────────────────────────────────────────────────────────

test('une requête mutante d’origine tierce est refusée', () => {
  const res = fakeRes();
  let suite = false;
  sameOriginGuard(
    fakeReq({ method: 'POST', headers: { origin: 'https://pirate.example', host: 'cowork.example.com' } }),
    res, () => { suite = true; }
  );
  assert.equal(suite, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'ORIGINE_INTERDITE');
});

test('Sec-Fetch-Site cross-site suffit à refuser la requête', () => {
  const res = fakeRes();
  let suite = false;
  sameOriginGuard(
    fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site', host: 'cowork.example.com' } }),
    res, () => { suite = true; }
  );
  assert.equal(suite, false);
  assert.equal(res.statusCode, 403);
});

test('une requête de même origine, ou sans origine, passe', () => {
  for (const headers of [
    { origin: 'https://cowork.example.com', host: 'cowork.example.com', 'sec-fetch-site': 'same-origin' },
    { host: 'cowork.example.com' }, // client non-navigateur : pas de cookie ambiant
  ]) {
    let suite = false;
    sameOriginGuard(fakeReq({ method: 'POST', headers }), fakeRes(), () => { suite = true; });
    assert.equal(suite, true, `bloqué à tort : ${JSON.stringify(headers)}`);
  }
});

test('les méthodes sûres ne sont jamais bloquées', () => {
  let suite = false;
  sameOriginGuard(
    fakeReq({ method: 'GET', headers: { origin: 'https://pirate.example' } }),
    fakeRes(), () => { suite = true; }
  );
  assert.equal(suite, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Contrôle d'accès et disponibilité (CWE-284, CWE-770)
// ─────────────────────────────────────────────────────────────────────────────

test('le dernier administrateur ne peut être ni rétrogradé ni supprimé', () => {
  db.exec(`DELETE FROM users WHERE role = 'admin'`);
  const { user: admin } = adminCreateUser({
    first_name: 'Seul', last_name: 'Admin', email: 'seul@test.local', phone: '0600000004', role: 'admin',
  });
  assert.throws(() => adminUpdateUser(admin.id, { role: 'member' }), /DERNIER_ADMIN/);
  assert.throws(() => deleteUserAccount(admin.id), /DERNIER_ADMIN/);

  // Avec un second administrateur, l'opération redevient possible.
  adminCreateUser({
    first_name: 'Second', last_name: 'Admin', email: 'second@test.local', phone: '0600000005', role: 'admin',
  });
  assert.doesNotThrow(() => adminUpdateUser(admin.id, { role: 'member' }));
});

test('une réservation groupée démesurée est refusée', () => {
  const espace = db.prepare(
    `INSERT INTO spaces (name, kind, capacity, credits_per_hour) VALUES ('Test', 'zone', 10, 1)`
  ).run();
  const demain = new Date(Date.now() + 86_400_000).toISOString();
  const creneaux = Array.from({ length: 500 }, () => ({ start_at: demain, end_at: demain }));
  assert.throws(
    () => reserveBatch(1, Number(espace.lastInsertRowid), creneaux),
    /TROP_DE_CRENEAUX/
  );
});
