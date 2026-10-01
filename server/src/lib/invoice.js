import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');

const NAVY = '#1c3155';
const INK = '#182135';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const GREEN = '#15803d';
const RED = '#be123c';

/**
 * Normalise un horodatage : `created_at` SQLite est naïf (UTC sans suffixe `Z`).
 * @param {string|Date} v Horodatage brut.
 * @returns {Date}
 */
function toDate(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  return new Date(s);
}
const dtf = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short' });
const fmtDT = (v) => dtf.format(toDate(v));
const fmtD = (v) => df.format(toDate(v));
const eur = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';

/**
 * Libellé lisible d'une écriture du grand-livre.
 * @param {object} t Ligne de `credit_transactions` enrichie.
 * @returns {string}
 */
function describe(t) {
  switch (t.reason) {
    case 'topup':
      return 'Recharge de crédits' + (t.note ? ` — ${t.note}` : '');
    case 'booking':
      return 'Réservation' + (t.space_name ? ` — ${t.space_name}` : '') + (t.start_at ? `, ${fmtDT(t.start_at)}` : '');
    case 'refund':
      return 'Remboursement' + (t.space_name ? ` — ${t.space_name}` : '');
    case 'adjust':
      return 'Ajustement' + (t.note ? ` — ${t.note}` : '');
    default:
      return t.note || t.reason;
  }
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Écrit le PDF du relevé directement dans la réponse HTTP (flux, sans fichier
 * temporaire sur disque).
 *
 * ⚠️ Les en-têtes HTTP sont déjà émis par l'appelant : toute erreur survenant
 * ici produirait un document tronqué. C'est pourquoi la période et l'existence
 * du membre sont validées AVANT l'appel (cf. `parsePeriod`).
 *
 * @param {import('express').Response} res Réponse HTTP servant de flux de sortie.
 * @param {object} params
 * @param {object} params.member Membre concerné (nom, e-mail, téléphone).
 * @param {object[]} params.transactions Écritures de la période.
 * @param {string} params.fromIso Début de période (ISO/UTC).
 * @param {string} params.toIso Fin de période (ISO/UTC), exclue.
 * @returns {void}
 */
export function streamInvoicePdf(res, { member, transactions, fromIso, toIso }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  const left = 50;
  const right = 545;
  const width = right - left;

  // ── En-tête ────────────────────────────────────────────────────────────────
  let brandX = left;
  try {
    doc.image(LOGO_PATH, left, 44, { width: 46, height: 46 });
    brandX = left + 56; // décale le texte à droite du logo
  } catch {
    /* logo absent : on garde juste le texte */
  }
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('Cazalia', brandX, 50);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Espace de co-working', brandX, 74);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text('Relevé de compte', left, 52, { width, align: 'right' });
  const ref = `REL-${member.id}-${df.format(new Date()).replace(/\//g, '')}`;
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text(`Référence : ${ref}`, left, 76, { width, align: 'right' })
    .text(`Émis le ${fmtD(new Date())}`, left, 88, { width, align: 'right' });

  doc.moveTo(left, 110).lineTo(right, 110).strokeColor(LINE).stroke();

  // ── Membre + période ─────────────────────────────────────────────────────────
  const startLabel = fmtD(fromIso);
  const endLabel = fmtD(new Date(toDate(toIso).getTime() - 1));
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Membre', left, 126);
  doc.font('Helvetica').fillColor(INK).fontSize(10).text(member.display_name, left, 140);
  doc.fillColor(MUTED).text(member.email, left, 154);
  if (member.phone) doc.text(member.phone, left, 168);

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Période', 350, 126);
  doc.font('Helvetica').fillColor(MUTED).text(`Du ${startLabel} au ${endLabel}`, 350, 140);

  // ── Tableau des transactions ─────────────────────────────────────────────────
  const cols = { date: left, op: 140, cr: 400, mt: 470 };
  let y = 196;
  const drawHeader = () => {
    doc.fillColor(NAVY).rect(left, y, width, 20).fill();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
    doc.text('Date', cols.date + 6, y + 6);
    doc.text('Opération', cols.op + 6, y + 6);
    doc.text('Crédits', cols.cr, y + 6, { width: 60, align: 'right' });
    doc.text('Montant', cols.mt, y + 6, { width: 69, align: 'right' });
    y += 20;
  };
  drawHeader();
  doc.font('Helvetica').fontSize(9);

  let totalCents = 0;
  let creditsAchetes = 0;
  let creditsUtilises = 0;

  if (transactions.length === 0) {
    doc.fillColor(MUTED).text('Aucune transaction sur cette période.', left + 6, y + 8);
    y += 28;
  }
  for (const t of transactions) {
    if (y > 770) {
      doc.addPage();
      y = 50;
      drawHeader();
      doc.font('Helvetica').fontSize(9);
    }
    if (t.amount_eur_cents) totalCents += t.amount_eur_cents;
    if (t.amount > 0 && t.reason === 'topup') creditsAchetes += t.amount;
    if (t.amount < 0) creditsUtilises += -t.amount;

    doc.fillColor(INK).text(fmtDT(t.created_at), cols.date + 6, y + 5, { width: 88 });
    doc.fillColor(INK).text(truncate(describe(t), 52), cols.op + 6, y + 5, { width: 252 });
    doc.fillColor(t.amount >= 0 ? GREEN : RED).text((t.amount >= 0 ? '+' : '') + t.amount, cols.cr, y + 5, { width: 60, align: 'right' });
    doc.fillColor(INK).text(t.amount_eur_cents ? eur(t.amount_eur_cents) : '—', cols.mt, y + 5, { width: 69, align: 'right' });
    y += 20;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#eef0f3').stroke();
  }

  // ── Totaux ───────────────────────────────────────────────────────────────────
  y += 16;
  if (y > 740) { doc.addPage(); y = 50; }
  const labelX = 320;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.text('Crédits achetés sur la période', labelX, y, { width: 150 });
  doc.text(`${creditsAchetes}`, 470, y, { width: 69, align: 'right' });
  y += 18;
  doc.text('Crédits utilisés sur la période', labelX, y, { width: 150 });
  doc.text(`${creditsUtilises}`, 470, y, { width: 69, align: 'right' });
  y += 18;
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor(LINE).stroke();
  y += 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY);
  doc.text('Total payé', labelX, y, { width: 150 });
  doc.text(eur(totalCents), 470, y, { width: 69, align: 'right' });
  y += 30;

  // ── Pied de page ─────────────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
    'Document généré automatiquement. Les crédits sont valables uniquement au sein de Cazalia ' +
    'et ne sont pas remboursables en espèces.',
    left, Math.max(y, 770), { width, align: 'center' }
  );

  doc.end();
}
