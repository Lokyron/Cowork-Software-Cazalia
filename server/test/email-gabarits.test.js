// Gabarits d'e-mail : version texte, en-têtes de désinscription, rendu des 10 gabarits.
//
// Aucun appel réseau : `fetch` (Brevo) et `nodemailer.createTransport` (SMTP) sont
// remplacés par des doublures. Exécution : npm test (depuis server/).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cazalia-gabarits-')), 'test.db');
process.env.DB_PATH = TMP_DB;
process.env.APP_SECRET = crypto.randomBytes(32).toString('hex');
process.env.SCRYPT_N = '16384';

const settings = await import('../src/lib/settings.js');
const { sendMail, sendToUser, renderTemplate, renderRaw, footerVariant } = await import('../src/lib/mailer.js');
const { htmlToText } = await import('../src/lib/html.js');
const { DEFAULT_TEMPLATES, INTERNAL_TEMPLATES } = await import('../src/lib/emailTemplates.js');
const { default: nodemailer } = await import('nodemailer');
const { db } = await import('../src/db.js');

test.after(() => { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); });

// ── Conversion HTML → texte ──────────────────────────────────────────────────

test('htmlToText : liens rendus « libellé (URL) », entités déséchappées, balises retirées', () => {
  const t = htmlToText(`<!doctype html><html><head><title>X</title><style>p{color:red}</style></head>
    <body><div style="display:none">Aperçu masqué</div>
    <h1 style="margin:0">Titre &amp; suite</h1>
    <p>Bonjour <strong>Marie</strong>,<br>voici <a href="https://cazalia.fr/a?x=1&amp;y=2" style="color:red">votre lien</a>.</p>
    <ul><li>Un &lt;tag&gt;</li><li>&quot;Deux&quot; l&#39;autre&nbsp;!</li></ul>
    <table><tr><td>Espace</td><td>Salle</td></tr></table>
    <script>alert(1)</script></body></html>`);
  assert.match(t, /Titre & suite/);
  assert.match(t, /votre lien \(https:\/\/cazalia\.fr\/a\?x=1&y=2\)/);
  assert.match(t, /^- Un <tag>$/m);
  assert.match(t, /^- "Deux" l'autre !$/m);
  assert.match(t, /^Espace Salle$/m);
  assert.doesNotMatch(t, /Aperçu masqué|alert|color:red|X\n/);
  assert.doesNotMatch(t, /<\/?(p|a|h1|ul|li|td|tr|table|strong|br|div|body|html)\b/i); // aucun HTML résiduel (« <tag> » déséchappé = texte)
});

test("htmlToText : lien dont le libellé est l'URL, mailto, saut de ligne préservé en pre-wrap, lignes vides effondrées", () => {
  const t = htmlToText(`<p><a href="https://cazalia.fr/x">https://cazalia.fr/x</a></p>
    <p><a href="mailto:a@b.fr">a@b.fr</a></p>
    <p style="white-space:pre-wrap;">ligne 1
ligne 2</p><br><br><br><br><p>fin</p>`);
  assert.equal(t, 'https://cazalia.fr/x\n\na@b.fr\n\nligne 1\nligne 2\n\nfin\n');
  assert.equal(htmlToText(''), '');
});

// ── sendMail : texte + en-têtes, aux deux fournisseurs ───────────────────────

function stubFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ messageId: '<m@brevo>' }) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
function stubSmtp() {
  const sent = [];
  const orig = nodemailer.createTransport;
  nodemailer.createTransport = () => ({ sendMail: async (msg) => { sent.push(msg); return { messageId: '<smtp@test>' }; } });
  return { sent, restore: () => { nodemailer.createTransport = orig; } };
}
const HTML = '<p>Bonjour <a href="https://cazalia.fr/x">ici</a></p>';

test('Brevo reçoit textContent (conversion auto, ou texte explicite prioritaire)', async () => {
  settings.setSmtp({ from_name: 'Cazalia', from_email: 'no-reply@cazalia.test' });
  settings.setBrevo({ api_key: 'xkeysib-test' });
  settings.setMail({ provider: 'brevo', daily_limit: 0, marketing_reserve: 0 });
  const f = stubFetch();
  try {
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'booking_confirmation' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, text: 'Texte explicite', templateCode: 'booking_confirmation' });
  } finally { f.restore(); }
  assert.equal(f.calls[0].body.textContent, 'Bonjour ici (https://cazalia.fr/x)\n');
  assert.equal(f.calls[1].body.textContent, 'Texte explicite');
  assert.equal(f.calls[0].body.headers, undefined); // transactionnel : pas d'en-tête de désinscription
});

test('SMTP reçoit text (conversion auto, ou texte explicite prioritaire)', async () => {
  settings.setMail({ provider: 'smtp', daily_limit: 0, marketing_reserve: 0 });
  settings.setSetting('smtp', { host: 'smtp.exemple.test', port: 587, from_email: 'no-reply@exemple.test' });
  const s = stubSmtp();
  try {
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'booking_confirmation' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, text: 'Texte explicite', templateCode: 'booking_confirmation' });
  } finally { s.restore(); }
  assert.equal(s.sent[0].text, 'Bonjour ici (https://cazalia.fr/x)\n');
  assert.equal(s.sent[1].text, 'Texte explicite');
  assert.equal(s.sent[0].headers, undefined);
});

test('List-Unsubscribe : présent en marketing (2 fournisseurs), absent sur password_reset / email_verification', async () => {
  // SMTP (fournisseur courant)
  const s = stubSmtp();
  try {
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'manual' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'booking_confirmation', marketing: true });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'password_reset' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'email_verification' });
  } finally { s.restore(); }
  assert.match(s.sent[0].headers['List-Unsubscribe'], /^<mailto:[^>]+>$/);
  assert.ok(s.sent[1].headers['List-Unsubscribe']);
  assert.equal(s.sent[2].headers, undefined);
  assert.equal(s.sent[3].headers, undefined);

  // Brevo
  settings.setBrevo({ api_key: 'xkeysib-test' });
  settings.setMail({ provider: 'brevo', daily_limit: 0, marketing_reserve: 0 });
  const f = stubFetch();
  try {
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'manual' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'password_reset' });
    await sendMail({ to: 'a@exemple.test', subject: 'S', html: HTML, templateCode: 'email_verification' });
  } finally { f.restore(); }
  assert.match(f.calls[0].body.headers['List-Unsubscribe'], /^<mailto:/);
  assert.equal(f.calls[1].body.headers, undefined);
  assert.equal(f.calls[2].body.headers, undefined);
});

// ── Rendu des 10 gabarits ────────────────────────────────────────────────────

const VARS = {
  first_name: 'Marie', client_name: 'Marie Dupont', space_name: 'Salle de réunion',
  booking_date: 'jeu. 4 déc. 2026', booking_time: '09:00 - 12:00', price: '48,00 €',
  wifi_voucher: 'K7P2-9QXM', access_pin: '482915', arrival_instructions: 'Entrée au 12 rue des Lilas.',
  dashboard_url: 'https://cazalia.fr/mon-espace', calendar_url: 'https://calendar.google.com/x?a=1&b=2',
  previous_date: 'mer. 3 déc. 2026', previous_time: '14:00 - 17:00', refund_info: 'Remboursement sous quelques jours.',
  reset_link: 'https://cazalia.fr/reset-password?token=abc', verify_link: 'https://cazalia.fr/verify?token=abc',
  lead_subject: 'Bureau privatif', lead_message: 'Bonjour',
};

function renderInternal() {
  const L = INTERNAL_TEMPLATES;
  const common = { id: 7, first_name: 'Marie', last_name: 'Dupont', email: 'm@exemple.test', phone: '0600000000' };
  return {
    lead_notification: renderRaw(L.lead_notification.subject, L.lead_notification.body({ hasNeed: true }), {
      ...common, title: 'Nouvelle demande de contact', lead_subject: 'Bureau', activity: 'Indépendante', source: '-',
      need: 'Postes : 4', message_label: 'Besoin particulier', message: 'Bonjour',
    }, { footer: 'internal' }),
    claim_notification: renderRaw(L.claim_notification.subject, L.claim_notification.body(), {
      ...common, kind: 'Réclamation', reservation_ref: '#1', message: 'Problème',
    }, { footer: 'internal' }),
    refund_request: renderRaw(L.refund_request.subject, L.refund_request.body({ hasPaymentIntent: true }), {
      amount: '48,00 €', member_name: 'Marie', member_email: 'm@exemple.test', space_name: 'Salle',
      slot: 'jeu. 09:00 - 12:00', payment_intent: 'pi_123',
    }, { footer: 'internal' }),
  };
}

test('les 10 gabarits se rendent sans marqueur {{…}} résiduel ni href vide, avec une version texte', () => {
  const rendered = {};
  for (const t of DEFAULT_TEMPLATES) rendered[t.code] = renderTemplate(t.code, VARS);
  Object.assign(rendered, renderInternal());
  assert.equal(Object.keys(rendered).length, 10);
  for (const [code, r] of Object.entries(rendered)) {
    assert.ok(r, `${code} introuvable`);
    assert.doesNotMatch(r.subject, /\{\{/, `${code} : marqueur dans le sujet`);
    assert.doesNotMatch(r.html, /\{\{|\}\}/, `${code} : marqueur résiduel`);
    assert.doesNotMatch(r.html, /href=(""|'')/, `${code} : href vide`);
    assert.match(r.html, /<meta name="color-scheme" content="light dark">/);
    assert.match(r.html, /prefers-color-scheme: dark/);
    assert.match(r.html, /width="115"/);
    const text = htmlToText(r.html);
    assert.ok(text.length > 40, `${code} : version texte vide`);
    // Vaut pour des variables SANS HTML (VARS). Le cas d'un visiteur qui saisit du balisage est
    // traité à part, dans « HTML saisi par un visiteur » ci-dessous.
    assert.doesNotMatch(text, /<[a-z/]|\{\{/i, `${code} : HTML résiduel dans le texte`);
  }
});

test("le bouton « Ajouter à mon agenda » n'est rendu que si calendar_url est fourni", () => {
  const sans = renderTemplate('booking_confirmation', { ...VARS, calendar_url: '' });
  assert.doesNotMatch(sans.html, /Ajouter à mon agenda/);
  assert.doesNotMatch(sans.html, /href=(""|'')/);
  assert.match(renderTemplate('booking_confirmation', VARS).html, /Ajouter à mon agenda/);
});

test('liens de secours en clair (reset, vérification), préheader et mentions de pied selon le destinataire', () => {
  const reset = renderTemplate('password_reset', VARS);
  assert.match(reset.html, /Si le bouton ne fonctionne pas, copiez ce lien/);
  assert.match(htmlToText(reset.html), /^https:\/\/cazalia\.fr\/reset-password\?token=abc$/m);
  assert.match(reset.html, /display:none[^>]*>Ce lien est valable 2 heures\./);
  assert.match(renderTemplate('email_verification', VARS).html, /Si le bouton ne fonctionne pas/);
  assert.match(renderTemplate('lead_ack', VARS).html, /suite à votre demande de contact/);
  assert.match(renderTemplate('booking_cancelled', VARS).html, /lié à votre compte/);
  assert.match(renderInternal().refund_request.html, /Notification interne/);
  assert.doesNotMatch(renderTemplate('booking_confirmation', VARS).html, /display:none/); // pas de préheader
  db.prepare(`DELETE FROM app_settings WHERE key = 'smtp'`).run();
});

// ── HTML saisi par un visiteur : comportement voulu ──────────────────────────

test('HTML saisi par un visiteur : inerte dans la partie HTML, balisage en clair dans la partie texte (choix assumé)', () => {
  const piege = '<a href="https://evil.example/x">cliquez</a> <script>alert(1)</script>';
  // Gabarits concernés : notifications internes (gérante, administrateurs) et accusé au visiteur lui-même.
  const L = INTERNAL_TEMPLATES.lead_notification;
  const notif = renderRaw(L.subject, L.body({ hasNeed: false }), {
    id: 9, title: 'Nouvelle demande', lead_subject: 'Bureau', first_name: 'Eve', last_name: 'X',
    email: 'eve@exemple.test', phone: '0600000000', activity: '-', source: '-', message_label: 'Message', message: piege,
  }, { footer: 'internal' });
  const ack = renderTemplate('lead_ack', { ...VARS, lead_message: piege });

  for (const r of [notif, ack]) {
    // HTML : échappé, donc aucun lien ni script exécutable issu de la saisie.
    assert.doesNotMatch(r.html, /<a href="https:\/\/evil\.example/);
    assert.doesNotMatch(r.html, /<script>alert/);
    assert.match(r.html, /&lt;a href=&quot;https:\/\/evil\.example\/x&quot;&gt;cliquez&lt;\/a&gt;/);
    // Texte : `htmlToText` déséchappe les entités, le balisage ressort donc LITTÉRALEMENT. C'est voulu :
    // text/plain n'interprète rien, et ces messages vont à la gérante / aux admins (qui voient le
    // balisage tel quel) ou au visiteur lui-même. Ce n'est pas un vecteur de hameçonnage.
    const text = htmlToText(r.html);
    assert.ok(text.includes('<a href="https://evil.example/x">cliquez</a>'), 'balisage en clair dans le texte');
    assert.ok(text.includes('<script>alert(1)</script>'));
  }
});

test('htmlToText : HTML mal formé, entités numériques invalides et chaînes longues sans exception ni blocage', () => {
  const run = (nom, html, maxMs = 3000) => {
    const t0 = Date.now();
    let out;
    assert.doesNotThrow(() => { out = htmlToText(html); }, nom);
    assert.equal(typeof out, 'string', nom);
    assert.ok(Date.now() - t0 < maxMs, `${nom} : trop lent (${Date.now() - t0} ms)`);
    return out;
  };
  // Ancres jamais fermées, balises tronquées, imbrication croisée.
  const orphan = run('ancres non fermées', '<a href="https://x.test">lien '.repeat(2000));
  assert.ok(orphan.length > 0);
  assert.equal(run('balise tronquée', 'avant <a href="https://x.test'), 'avant <a href="https://x.test\n');
  run('imbrication croisée', '<a href="1"><p>x</a></p></a><a><a>');
  run('guillemets déséquilibrés', '<a href="https://x.test>texte</a> <a href=\'y>z</a>');
  // Entités numériques : valides, hors plage, nulles, énormes, non hexadécimales.
  assert.equal(run('entités valides', '&#65;&#x42;&#X43;'), 'ABC\n');
  const bad = run('entités invalides', '&#0;&#x110000;&#99999999999999999999;&#xZZ;&#;&unknown;&amp;lt;');
  assert.ok(bad.includes('&unknown;') && bad.includes('&lt;'), 'entité inconnue conservée, double échappement décodé une seule fois');
  // Chaînes longues (tailles bien au-delà des champs réels, plafonnés à 2000 caractères).
  run('1 Mo de texte', 'mot '.repeat(250000));
  run('1 M de « & »', '&'.repeat(1_000_000));
  run('balise ouverte de 1 Mo', `<a ${'x'.repeat(1_000_000)}`);
  run('20 000 « < »', '<'.repeat(20000));
});

// ── Pied de page et en-têtes : une seule source de vérité ────────────────────

test('footerVariant dérive de la même classification que les en-têtes (mailKind)', () => {
  assert.equal(footerVariant('manual'), 'marketing');
  assert.equal(footerVariant('booking_confirmation', true), 'marketing'); // campagne sur un code non « manual »
  assert.equal(footerVariant('lead_ack'), 'contact');
  assert.equal(footerVariant('booking_confirmation'), 'account');
  assert.equal(footerVariant('password_reset'), 'account');
  assert.equal(footerVariant('email_verification', false), 'account');
});

test('campagne sur un code autre que « manual » : List-Unsubscribe ET pied commercial, jamais le pied de service', async () => {
  settings.setMail({ provider: 'smtp', daily_limit: 0, marketing_reserve: 0 });
  settings.setSetting('smtp', { host: 'smtp.exemple.test', port: 587, from_email: 'no-reply@exemple.test' });
  const uid = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, first_name, role, notify_booking, notify_marketing)
     VALUES ('campagne@exemple.test', 'x', 'Marie D', 'Marie', 'member', 1, 1)`
  ).run().lastInsertRowid);
  const s = stubSmtp();
  try {
    for (const code of ['booking_confirmation', 'booking_cancelled', 'lead_ack', 'manual']) {
      for (const marketing of [false, true]) {
        await sendToUser({ userId: uid, code, vars: VARS, marketing });
      }
    }
  } finally { s.restore(); }
  assert.equal(s.sent.length, 8);
  for (const msg of s.sent) {
    const unsub = Boolean(msg.headers?.['List-Unsubscribe']);
    const footerMarketing = /Pour vous désinscrire/.test(msg.html);
    const footerService = /E-mail de service lié à votre compte/.test(msg.html);
    assert.equal(footerMarketing, unsub, `${msg.subject} : pied commercial et en-tête divergent`);
    assert.ok(!(unsub && footerService), `${msg.subject} : en-tête de désinscription ET pied « e-mail de service »`);
  }
  // Cas visé par la review : code de service + marketing:true => en-tête et pied commerciaux.
  const camp = s.sent.find((m) => /Votre réservation Salle de réunion - /.test(m.subject) && m.headers);
  assert.ok(camp, 'envoi de campagne sur booking_confirmation trouvé');
  assert.match(camp.html, /Pour vous désinscrire/);
  assert.doesNotMatch(camp.html, /E-mail de service lié/);
});

// ── Mode sombre : aucun bouton illisible, ancien comme nouveau balisage ──────

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Mini-cascade des règles de lien du mode sombre : toutes sont `!important`, donc elles battent
// le style en ligne ; entre elles, la spécificité (attributs + classes, puis éléments), puis l'ordre.
const CARD_BG = '#1a2233';
const specificity = (sel) => [
  (sel.match(/\.[\w-]+/g) || []).length + (sel.match(/\[[^\]]*\]/g) || []).length,
  (sel.match(/(^|\s)[a-z]+(?=\[|$|\s)/g) || []).length,
];
const hexOf = (v) => {
  const h = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(v || '');
  if (!h) return null;
  return `#${h[1].length === 3 ? [...h[1]].map((c) => c + c).join('') : h[1]}`.toLowerCase();
};
const darkRules = (html) => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  return [...dark.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, order) => ({
    sel: m[1].trim(), order,
    decl: Object.fromEntries(m[2].split(';').map((d) => d.split(':').map((x) => x.replace('!important', '').trim())).filter((d) => d[0] && d[1])),
  }));
};
/**
 * Couleurs effectives d'un <a> en mode sombre. `wrapper` : classe de la cellule qui le porte.
 * `rules` : les règles que le client a conservées.
 */
const darkLink = (rules, style, wrapper = null) => {
  const matches = (sel) => {
    if (sel === '.em-card a') return true;
    const attr = /^\.em-card a\[style\*="([^"]+)"\]$/.exec(sel);
    if (attr) return style.includes(attr[1]);
    const w = /^\.em-card \.(em-btn(?:-ghost)?) a$/.exec(sel);
    return Boolean(w) && w[1] === wrapper;
  };
  const won = {};
  const hit = rules.filter((r) => matches(r.sel))
    .sort((x, y) => (specificity(x.sel)[0] - specificity(y.sel)[0]) || (specificity(x.sel)[1] - specificity(y.sel)[1]) || (x.order - y.order));
  for (const r of hit) Object.assign(won, r.decl);
  const own = /background(?:-color)?\s*:\s*([^;]+)/.exec(style)?.[1];
  const cell = rules.find((r) => wrapper && r.sel === `.em-card .${wrapper}`)?.decl.background;
  const parentBg = cell || CARD_BG;
  const bgDecl = won.background ?? own;
  const bg = (bgDecl && bgDecl.trim() !== 'transparent' ? hexOf(bgDecl) : null) || parentBg;
  const inlineColor = hexOf(/(?:^|;)\s*color\s*:\s*([^;]+)/.exec(style)?.[1]);
  return { color: hexOf(won.color) || inlineColor, bg };
};

test('mode sombre : aucun lien sous 4,5:1, ancien comme nouveau balisage, y compris un <a> de texte portant « background »', () => {
  const html = renderTemplate('booking_confirmation', VARS).html;
  const rules = darkRules(html);
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(!css.includes(':not('), 'plus de :not() : un client qui le rejette ne perd pas la recoloration');

  const cases = {
    'lien de texte (bleu marine en ligne)': ['color:#1c3155;text-decoration:underline;', null],
    'lien de texte à background-color collé de Word': ['color:#1c3155;background-color:#fff;', null],
    'lien de texte à background:transparent': ['color:#1c3155;background:transparent;', null],
    'lien de texte à fond blanc collé': ['color:#1c3155;background:#ffffff;', null],
    'ancien bouton plein (corps en base)': ['display:inline-block;background:#1c3155;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-weight:600;', null],
    'ancien bouton fantôme (corps en base)': ['display:inline-block;background:#ffffff;color:#1c3155;text-decoration:none;padding:10px 18px;border-radius:9px;font-weight:600;border:1px solid rgba(28,49,85,.25);', null],
    'nouveau bouton plein': ['display:block;padding:14px 22px;color:#ffffff;text-decoration:none;', 'em-btn'],
    'nouveau bouton fantôme': ['display:block;padding:13px 21px;color:#1c3155;text-decoration:none;', 'em-btn-ghost'],
  };
  for (const [nom, [style, wrapper]] of Object.entries(cases)) {
    const { color, bg } = darkLink(rules, style, wrapper);
    assert.ok(contrast(color, bg) >= 4.5, `${nom} : ${color} sur ${bg} = ${contrast(color, bg).toFixed(2)}:1`);
  }
  // Valeurs de référence (cascade correcte sur le nouveau balisage).
  const plein = darkLink(rules, cases['nouveau bouton plein'][0], 'em-btn');
  const fantome = darkLink(rules, cases['nouveau bouton fantôme'][0], 'em-btn-ghost');
  assert.ok(contrast(plein.color, plein.bg) > 5.9 && contrast(fantome.color, fantome.bg) > 10);

  // Ordre des règles de lien : générale, puis restaurations, puis boutons (la dernière gagne à spécificité égale).
  const iGen = rules.findIndex((r) => r.sel === '.em-card a');
  assert.ok(iGen >= 0 && rules.findIndex((r) => r.sel === '.em-card .em-btn a') > iGen
    && rules.findIndex((r) => r.sel === '.em-card .em-btn-ghost a') > iGen);
  // Le balisage courant porte bien les classes visées.
  assert.match(html, /class="em-btn"/);
  assert.match(html, /class="em-btn-ghost"/);
});

test('mode sombre : la recoloration par attribut est ignorée par le client => liens de texte et nouveau balisage restent lisibles', () => {
  const rules = darkRules(renderTemplate('booking_confirmation', VARS).html);
  // Client qui honore les media queries et les classes mais rejette `[style*=…]` (et `:not`).
  const reduit = rules.filter((r) => !r.sel.includes('[') && !r.sel.includes(':not('));
  assert.ok(reduit.length < rules.length && reduit.some((r) => r.sel === '.em-card a'));
  for (const [nom, style, wrapper] of [
    ['lien de texte', 'color:#1c3155;text-decoration:underline;', null],
    ['ancien bouton plein', 'display:inline-block;background:#1c3155;color:#fff;', null],
    ['nouveau bouton plein', 'display:block;color:#ffffff;', 'em-btn'],
    ['nouveau bouton fantôme', 'display:block;color:#1c3155;', 'em-btn-ghost'],
  ]) {
    const { color, bg } = darkLink(reduit, style, wrapper);
    assert.ok(contrast(color, bg) >= 4.5, `${nom} sans règles d'attribut : ${color} sur ${bg} = ${contrast(color, bg).toFixed(2)}:1`);
  }
  // Limite documentée (cf. commentaire de DARK_CSS) : sans les règles d'attribut, un ancien bouton
  // fantôme (fond blanc en ligne) ou un lien à fond clair collé n'est plus recoloré.

  // Client qui rejette les sélecteurs DESCENDANTS : le fond sombre de la carte part avec les règles
  // de texte (même forme de sélecteur), la carte reste claire à texte foncé.
  const bgRule = rules.find((r) => r.decl.background === CARD_BG && /em-card/.test(r.sel));
  const textRule = rules.find((r) => /\.em-card td/.test(r.sel) && r.decl.color);
  assert.ok(/\s/.test(bgRule.sel) && /\s/.test(textRule.sel), 'fond et texte de la carte tombent ensemble');
});
