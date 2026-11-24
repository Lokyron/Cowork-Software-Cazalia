// Migration `migr_email_bulletproof_v1` : boutons « bulletproof », liens de secours en clair et
// « Ancien créneau » plus lisible, appliqués aux gabarits DÉJÀ EN BASE (le semis par
// INSERT OR IGNORE ne les touche pas).
//
// Fixture : les corps tels que semés avant ce lot (anciens boutons `<a>` en ligne).
// La migration ne retouche qu'un motif exact : un corps modifié à la main, qui ne le contient
// plus, doit rester octet pour octet identique.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-emailbtn-migr-'));
const TMP_DB = path.join(TMP_DIR, 'cowork.db');
process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

// F3 : corps semés par aaddb60 (pile d'actions en tableau, anciens boutons `<a>` en ligne).
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/gabarits-avant-boutons.json', import.meta.url), 'utf8'));
// F2 : corps de TOUTE installation antérieure à aaddb60, après migr_calendar_btn_v1 puis
// migr_cta_stack_v1 (« <p> bouton <br><br> bouton agenda </p> »). Reconstitués à partir de F3 en
// rejouant les deux migrations d'époque (bouton seul `<p style="margin:18px 0 0;">`, puis ajout du
// bouton agenda, puis `&nbsp;&nbsp;` remplacé par `<br><br>`) ; les autres corps ne sont pas concernés.
const FIXTURE_F2 = JSON.parse(fs.readFileSync(new URL('./fixtures/gabarits-avant-boutons-f2.json', import.meta.url), 'utf8'));

// (a) Base neuve : le semis pose les nouveaux corps ; la migration ne doit rien y changer.
const { db } = await import('../src/db.js');
const { DEFAULT_TEMPLATES } = await import('../src/lib/emailTemplates.js');
const defaults = Object.fromEntries(DEFAULT_TEMPLATES.map((t) => [t.code, t.body_html]));
const body = (code) => db.prepare(`SELECT body_html FROM email_templates WHERE code = ?`).get(code).body_html;
const flag = () => db.prepare(`SELECT value FROM app_settings WHERE key = 'migr_email_bulletproof_v1'`).get();

test.after(() => { db.close(); fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

/** Second démarrage réel de db.js (processus fils, même fichier). */
const restart = () => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], {
  cwd: new URL('..', import.meta.url), env: { ...process.env, DB_PATH: TMP_DB }, stdio: 'pipe',
});
const reread = () => {
  // Le processus fils a écrit dans le même fichier (mode WAL éventuel) : relecture via une nouvelle connexion.
  const r = db.prepare(`SELECT code, body_html FROM email_templates`).all();
  return Object.fromEntries(r.map((x) => [x.code, x.body_html]));
};

test('(a) base neuve : les corps semés sont déjà au nouveau balisage, la migration les laisse intacts', () => {
  assert.ok(flag(), 'drapeau posé');
  for (const code of Object.keys(FIXTURE)) assert.equal(body(code), defaults[code], code);
});

test('(b) corps d\'avant le lot : boutons bulletproof, liens de secours et « Ancien créneau » migrés', () => {
  // Remise de la base dans l'état de production : anciens corps, drapeau absent.
  const set = db.prepare(`UPDATE email_templates SET body_html = ? WHERE code = ?`);
  for (const [code, html] of Object.entries(FIXTURE)) set.run(html, code);
  assert.ok(FIXTURE.password_reset.includes('display:inline-block;background:#1c3155'), 'fixture = ancien balisage');
  assert.ok(!FIXTURE.password_reset.includes('Si le bouton ne fonctionne pas'));
  db.prepare(`DELETE FROM app_settings WHERE key = 'migr_email_bulletproof_v1'`).run();
  const avant = { ...FIXTURE };

  restart();
  const apres = reread();
  assert.ok(flag());

  // Les six corps migrés rendent EXACTEMENT comme un corps neuf (boutons, <div>, lien de secours,
  // et, pour les réservations, mêmes espacements : pas de double padding entre les deux boutons).
  for (const code of Object.keys(FIXTURE)) {
    assert.equal(apres[code], defaults[code], `${code} migré = gabarit courant`);
  }
  assert.match(apres.password_reset, /Si le bouton ne fonctionne pas, copiez ce lien/);
  assert.match(apres.password_reset, /<span style="word-break:break-all;">\{\{reset_link\}\}<\/span>/);
  assert.match(apres.email_verification, /<span style="word-break:break-all;">\{\{verify_link\}\}<\/span>/);

  // Réservations : boutons de la pile remplacés sur place, ligne agenda balisée, jeton conservé.
  for (const code of ['booking_confirmation', 'booking_modified']) {
    const b = apres[code];
    assert.doesNotMatch(b, /display:inline-block;background:#/, `${code} : plus d'ancien bouton`);
    assert.match(b, /class="em-btn"/);
    assert.match(b, /class="em-btn-ghost"/);
    assert.match(b, /<!--cal--><tr><td style="padding:10px 0 0;">.*href="\{\{calendar_url\}\}".*<!--\/cal-->/s);
    assert.match(b, /href="\{\{dashboard_url\}\}"/);
    assert.notEqual(b, avant[code]);
  }
  assert.match(apres.booking_modified, /text-align:right;color:#5b6577;text-decoration:line-through;/);
  assert.doesNotMatch(apres.booking_modified, /#9aa3b2/);
});

test('(b2) forme F2 (installation antérieure au tableau) : même balisage final que depuis F3, libellé agenda conservé', () => {
  assert.match(FIXTURE_F2.booking_confirmation, /<p style="margin:18px 0 0;"><a [^>]*>[^<]*<\/a><br><br><a /);
  assert.doesNotMatch(FIXTURE_F2.booking_confirmation, /<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px/);
  const set = db.prepare(`UPDATE email_templates SET body_html = ? WHERE code = ?`);
  const rerun = (fixture) => {
    for (const [code, html] of Object.entries(fixture)) set.run(html, code);
    db.prepare(`DELETE FROM app_settings WHERE key = 'migr_email_bulletproof_v1'`).run();
    restart();
    return reread();
  };
  const depuisF3 = rerun({ booking_confirmation: FIXTURE.booking_confirmation, booking_modified: FIXTURE.booking_modified });
  const depuisF2 = rerun(FIXTURE_F2);
  for (const code of ['booking_confirmation', 'booking_modified']) {
    assert.doesNotMatch(depuisF2[code], /display:inline-block;background:#/, `${code} : plus d'ancien bouton`);
    assert.doesNotMatch(depuisF2[code], /<br><br>/);
    assert.match(depuisF2[code], /class="em-btn"/);
    assert.match(depuisF2[code], /<!--cal--><tr><td style="padding:10px 0 0;">.*href="\{\{calendar_url\}\}".*<!--\/cal-->/s);
    assert.equal(depuisF2[code], depuisF3[code], `${code} : F2 et F3 aboutissent au même balisage`);
    assert.equal(depuisF2[code], defaults[code], `${code} : identique au gabarit neuf`);
  }

  // Libellé du bouton agenda retouché par la gérante : conservé. Marge du paragraphe modifiée
  // (motif non reconnu) : corps laissé octet pour octet.
  const retouche = FIXTURE_F2.booking_confirmation.replace('📅 Ajouter à mon agenda', 'Mettre dans mon calendrier');
  const perso = FIXTURE_F2.booking_modified.replace('<p style="margin:18px 0 0;">', '<p style="margin:30px 0 0;">');
  assert.notEqual(retouche, FIXTURE_F2.booking_confirmation);
  assert.notEqual(perso, FIXTURE_F2.booking_modified);
  const apres = rerun({ booking_confirmation: retouche, booking_modified: perso });
  assert.match(apres.booking_confirmation, /Mettre dans mon calendrier/);
  assert.match(apres.booking_confirmation, /class="em-btn-ghost"/);
  assert.equal(apres.booking_modified.includes('<p style="margin:30px 0 0;">'), true);
  assert.match(apres.booking_modified, /display:inline-block;background:#1c3155/);
  // Retour à l'état courant pour la suite du fichier.
  rerun({ booking_confirmation: defaults.booking_confirmation, booking_modified: defaults.booking_modified });
});

test('migration idempotente : un nouveau redémarrage ne modifie plus rien', () => {
  const avant = reread();
  restart();
  assert.deepEqual(reread(), avant);
});

test('(c) corps édités à la main : jamais écrasés ; seul le motif exact est retouché, le reste de l\'édition est conservé', () => {
  const set = db.prepare(`UPDATE email_templates SET body_html = ? WHERE code = ?`);
  // 1. Bouton conservé, texte réécrit par la gérante : le bouton est migré, le texte reste.
  const edite = FIXTURE.booking_cancelled.replace('a été annulée.', 'a été annulée (texte réécrit par la gérante).');
  assert.notEqual(edite, FIXTURE.booking_cancelled);
  // 2. Bouton personnalisé (autre padding) : motif absent => corps laissé tel quel, sans lien de secours.
  const perso = FIXTURE.password_reset.replace('padding:11px 20px', 'padding:16px 28px');
  assert.notEqual(perso, FIXTURE.password_reset);
  // 3. Corps entièrement réécrit.
  const libre = '<p>Message libre de la gérante, aucun bouton.</p>';
  set.run(edite, 'booking_cancelled');
  set.run(perso, 'password_reset');
  set.run(libre, 'manual');
  set.run(FIXTURE.email_verification, 'email_verification');
  db.prepare(`DELETE FROM app_settings WHERE key = 'migr_email_bulletproof_v1'`).run();

  restart();
  const apres = reread();

  assert.ok(apres.booking_cancelled.includes('(texte réécrit par la gérante)'), 'édition conservée');
  assert.match(apres.booking_cancelled, /class="em-btn"/);
  assert.equal(apres.password_reset, perso, 'bouton personnalisé : corps octet pour octet inchangé');
  assert.doesNotMatch(apres.password_reset, /Si le bouton ne fonctionne pas/);
  assert.equal(apres.manual, libre, 'corps libre inchangé');
  assert.equal(apres.email_verification, defaults.email_verification);
});
