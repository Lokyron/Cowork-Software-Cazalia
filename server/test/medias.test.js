// Tests des médias du site (photos modifiables depuis l'administration).
//
// Deux angles : la SÛRETÉ (un nom de fichier vient du client, un contenu
// d'image aussi) et la COHÉRENCE de l'affectation (carrousel, emplacements
// nommés) face à un dossier qui peut être modifié à la main sur le serveur.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-media-'));
const MEDIA_DIR = path.join(TMP_DIR, 'gallery');
fs.mkdirSync(MEDIA_DIR);

process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
process.env.GALLERY_DIR = MEDIA_DIR;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const media = await import('../src/lib/media.js');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// Images minimales mais porteuses d'une signature valide.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);

/** Repart d'un dossier et d'un réglage vides entre les cas. */
function reset() {
  for (const f of fs.readdirSync(MEDIA_DIR)) fs.rmSync(path.join(MEDIA_DIR, f));
  db.prepare(`DELETE FROM app_settings WHERE key = 'media'`).run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Noms de fichiers : traversée de répertoire (CWE-22)
// ─────────────────────────────────────────────────────────────────────────────

test('un nom de fichier hostile est refusé ou réduit à un nom nu', () => {
  assert.equal(media.mediaPath('../../../etc/passwd'), null);
  assert.equal(media.safeName('../../secret.jpg'), 'secret.jpg'); // chemin supprimé
  assert.equal(media.safeName('/etc/shadow'), null);              // extension refusée
  assert.equal(media.safeName('note.txt'), null);
  assert.equal(media.safeName('.cachee.jpg'), null);              // fichier caché
  assert.equal(media.safeName(''), null);
  assert.equal(media.safeName(undefined), null);
  // Un nom légitime reste inchangé, et son chemin tombe bien dans le dossier.
  assert.equal(media.safeName('cuisine-ab12cd.jpg'), 'cuisine-ab12cd.jpg');
  assert.ok(media.mediaPath('cuisine-ab12cd.jpg').startsWith(media.MEDIA_DIR + path.sep));
});

test('seules les extensions d\'image reçoivent un type MIME', () => {
  assert.equal(media.mimeForFile('a.jpg'), 'image/jpeg');
  assert.equal(media.mimeForFile('a.PNG'), 'image/png');
  assert.equal(media.mimeForFile('a.webp'), 'image/webp');
  assert.equal(media.mimeForFile('a.svg'), null); // SVG = script potentiel : jamais servi
  assert.equal(media.mimeForFile('a.html'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Contenu envoyé : le format est reconnu par la signature, pas par le nom
// ─────────────────────────────────────────────────────────────────────────────

test('un fichier qui n\'est pas une image est refusé', () => {
  reset();
  for (const payload of ['<?php system($_GET[0]); ?>', '<svg onload=alert(1)>', '#!/bin/sh\nrm -rf /']) {
    assert.throws(() => media.saveImage(Buffer.from(payload), 'innocent.jpg'), /FORMAT_NON_SUPPORTE/);
  }
  assert.equal(media.listFiles().length, 0, 'aucun fichier ne doit avoir été écrit');
});

test('l\'extension suit le contenu réel, pas le nom annoncé', () => {
  reset();
  // Contenu PNG présenté comme un .jpg → stocké en .png.
  const r = media.saveImage(PNG, 'photo.jpg');
  assert.match(r.file, /\.png$/);
  assert.equal(media.saveImage(WEBP, 'x.jpg').file.endsWith('.webp'), true);
  assert.equal(media.saveImage(JPEG, 'x.png').file.endsWith('.jpg'), true);
});

test('les noms sont assainis, uniques, et ne peuvent pas viser un fichier existant', () => {
  reset();
  const a = media.saveImage(JPEG, 'Cuisine Été 2026.JPG');
  assert.match(a.file, /^cuisine-ete-2026-[0-9a-f]{6}\.jpg$/);
  // Deux envois du même nom ne s'écrasent pas.
  const b = media.saveImage(JPEG, 'Cuisine Été 2026.JPG');
  assert.notEqual(a.file, b.file);
  assert.equal(media.listFiles().length, 2);
  // Un nom traversant est neutralisé avant écriture.
  const c = media.saveImage(JPEG, '../../../../etc/cron.d/pwn');
  assert.equal(path.dirname(path.join(media.MEDIA_DIR, c.file)), media.MEDIA_DIR);
});

// ─────────────────────────────────────────────────────────────────────────────
// Affectation : carrousel et emplacements nommés
// ─────────────────────────────────────────────────────────────────────────────

test('une photo déposée à la main sur le serveur apparaît dans le carrousel', () => {
  reset();
  // Comportement historique conservé : le dossier est la source, l'ordre
  // enregistré ne fait que le réordonner.
  fs.writeFileSync(path.join(MEDIA_DIR, 'galerie-1.jpg'), JPEG);
  fs.writeFileSync(path.join(MEDIA_DIR, 'galerie-2.jpg'), JPEG);
  assert.deepEqual(media.getMedia().carousel, ['galerie-1.jpg', 'galerie-2.jpg']);
});

test('l\'ordre enregistré prime, les nouveautés passent à la fin', () => {
  reset();
  for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) fs.writeFileSync(path.join(MEDIA_DIR, n), JPEG);
  media.setCarouselOrder(['c.jpg', 'a.jpg']);
  assert.deepEqual(media.getMedia().carousel, ['c.jpg', 'a.jpg', 'b.jpg']);
});

test('un ordre reçu ne peut pas introduire de fichier arbitraire ni de doublon', () => {
  reset();
  for (const n of ['a.jpg', 'b.jpg'] ) fs.writeFileSync(path.join(MEDIA_DIR, n), JPEG);
  const kept = media.setCarouselOrder(['b.jpg', '../../etc/passwd', 'absente.jpg', 'b.jpg', 'a.jpg']);
  assert.deepEqual(kept, ['b.jpg', 'a.jpg']);
});

test('un fichier disparu du disque sort du carrousel sans laisser de trou', () => {
  reset();
  for (const n of ['a.jpg', 'b.jpg'] ) fs.writeFileSync(path.join(MEDIA_DIR, n), JPEG);
  media.setCarouselOrder(['a.jpg', 'b.jpg']);
  fs.rmSync(path.join(MEDIA_DIR, 'a.jpg'));
  assert.deepEqual(media.getMedia().carousel, ['b.jpg']);
});

test('une photo promue en bandeau quitte le carrousel', () => {
  reset();
  for (const n of ['a.jpg', 'b.jpg'] ) fs.writeFileSync(path.join(MEDIA_DIR, n), JPEG);
  media.setCarouselOrder(['a.jpg', 'b.jpg']);
  media.setSlot('hero', 'a.jpg');
  const m = media.getMedia();
  assert.equal(m.hero, 'a.jpg');
  assert.deepEqual(m.carousel, ['b.jpg'], 'la même photo ne doit pas être aux deux endroits');
});

test('un emplacement inconnu est ignoré', () => {
  reset();
  fs.writeFileSync(path.join(MEDIA_DIR, 'a.jpg'), JPEG);
  media.setSlot('bandeau-pirate', 'a.jpg');
  assert.equal(media.getMedia().hero, null);
});

test('vider un emplacement rend la main à la photo du build', () => {
  reset();
  fs.writeFileSync(path.join(MEDIA_DIR, 'a.jpg'), JPEG);
  media.setSlot('presentation', 'a.jpg');
  assert.equal(media.getMedia().presentation, 'a.jpg');
  media.setSlot('presentation', null);
  assert.equal(media.getMedia().presentation, null, 'le front retombe alors sur /images/presentation.jpg');
});

// ─────────────────────────────────────────────────────────────────────────────
// Suppression
// ─────────────────────────────────────────────────────────────────────────────

test('supprimer une photo efface le fichier ET toutes ses affectations', () => {
  reset();
  fs.writeFileSync(path.join(MEDIA_DIR, 'a.jpg'), JPEG);
  fs.writeFileSync(path.join(MEDIA_DIR, 'b.jpg'), JPEG);
  media.setSlot('hero', 'a.jpg');
  media.setCarouselOrder(['b.jpg']);

  const detached = [];
  assert.equal(media.deleteImage('a.jpg', (f) => detached.push(f)), true);
  assert.equal(fs.existsSync(path.join(MEDIA_DIR, 'a.jpg')), false);
  assert.equal(media.getMedia().hero, null);
  assert.deepEqual(detached, ['a.jpg'], 'les espaces qui utilisaient la photo doivent être prévenus');
});

test('supprimer un nom hostile ou inexistant ne fait rien', () => {
  reset();
  assert.equal(media.deleteImage('../../../etc/passwd'), false);
  assert.equal(media.deleteImage('fantome.jpg'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Photo d'espace
// ─────────────────────────────────────────────────────────────────────────────

test('la colonne photo existe sur les espaces et accepte un nom nu', () => {
  const cols = db.prepare(`PRAGMA table_info(spaces)`).all().map((c) => c.name);
  assert.ok(cols.includes('photo'));
  const id = db.prepare(
    `INSERT INTO spaces (name, kind, capacity, credits_per_hour, color, active) VALUES ('Test', 'room', 4, 2, '#000', 1)`
  ).run().lastInsertRowid;
  db.prepare(`UPDATE spaces SET photo = ? WHERE id = ?`).run('salle-ab12cd.jpg', id);
  assert.equal(db.prepare(`SELECT photo FROM spaces WHERE id = ?`).get(id).photo, 'salle-ab12cd.jpg');
  // Le détachement utilisé à la suppression d'un média retrouve bien la ligne.
  db.prepare(`UPDATE spaces SET photo = NULL WHERE photo = ?`).run('salle-ab12cd.jpg');
  assert.equal(db.prepare(`SELECT photo FROM spaces WHERE id = ?`).get(id).photo, null);
});
