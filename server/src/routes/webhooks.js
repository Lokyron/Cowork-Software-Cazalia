// Webhooks entrants des fournisseurs d'e-mail — enrichissement du journal avec
// le statut RÉEL de délivrabilité (remis, rejeté, classé spam, désabonné).
//
// Sans ces événements, `email_log` ne dit qu'une chose : « le fournisseur a
// accepté le message ». C'est insuffisant pour diagnostiquer le cas qui compte —
// un client qui n'a jamais reçu son lien de réinitialisation.
//
// AUTHENTIFICATION : la route est publique (Brevo n'offre ni signature HMAC ni
// IP fixe) ; le secret est un JETON dans le CHEMIN, généré côté serveur et
// comparé en temps constant. Conséquences assumées et traitées ici :
//   - jeton renouvelable à tout moment depuis /admin/emails (l'ancien cesse
//     immédiatement d'être accepté) ;
//   - aucune donnée n'est LUE depuis la charge utile pour désigner un
//     destinataire : on ne met à jour qu'une ligne de journal déjà existante,
//     retrouvée par son identifiant de message ;
//   - limitation de débit, pour qu'un jeton deviné ou fuité ne permette pas de
//     marteler la base.

import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from '../db.js';
import { rateLimit } from '../security.js';
import { getBrevo } from '../lib/settings.js';
import { eventToStatus, normalizeMessageId } from '../lib/brevo.js';

export const webhooksRouter = Router();

/**
 * Comparaison de jetons en temps constant.
 * Une comparaison `===` sur une chaîne s'arrête au premier octet différent : le
 * temps de réponse fuite alors la longueur du préfixe correct (CWE-208).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Priorité des statuts : un événement de MOINDRE importance ne doit pas écraser
// un verdict plus grave déjà enregistré. Brevo peut livrer les événements dans
// le désordre (un `delivered` tardif après un `hard_bounce` sur un autre
// destinataire du même lot) ; sans cet ordre, le journal mentirait.
const RANK = {
  skipped: 0, sent: 1, deferred: 2, delivered: 3,
  unsubscribed: 4, blocked: 5, spam: 6, failed: 7, bounced: 8,
};

const findByMessageId = db.prepare(
  `SELECT id, status, to_user_id, to_email FROM email_log WHERE message_id = ? ORDER BY id DESC LIMIT 1`
);
const updateStatus = db.prepare(
  `UPDATE email_log SET status = ?, error = COALESCE(?, error), updated_at = datetime('now') WHERE id = ?`
);
// Un désabonnement ou un signalement en spam est une opposition explicite : on
// coupe les communications commerciales du membre concerné (RGPD, art. 21).
// Les e-mails transactionnels (réservation, mot de passe) restent dus.
const optOutByUser = db.prepare(`UPDATE users SET notify_marketing = 0 WHERE id = ?`);
const optOutByEmail = db.prepare(`UPDATE users SET notify_marketing = 0 WHERE email = ?`);

/**
 * Applique un événement de délivrabilité au journal.
 *
 * @param {object} ev Événement brut du fournisseur.
 * @returns {'applied' | 'ignored' | 'unknown'} `ignored` : événement non suivi ;
 *          `unknown` : message inconnu du journal (envoyé hors application).
 */
function applyEvent(ev) {
  const status = eventToStatus(ev?.event);
  if (!status) return 'ignored';
  const messageId = normalizeMessageId(ev?.['message-id'] ?? ev?.message_id ?? ev?.messageId);
  if (!messageId) return 'unknown';
  const row = findByMessageId.get(messageId);
  if (!row) return 'unknown';

  if ((RANK[status] ?? 0) >= (RANK[row.status] ?? 0)) {
    const reason = ev?.reason ? String(ev.reason).slice(0, 300) : null;
    updateStatus.run(status, reason, row.id);
  }
  if (status === 'unsubscribed' || status === 'spam') {
    if (row.to_user_id) optOutByUser.run(row.to_user_id);
    else if (row.to_email) optOutByEmail.run(row.to_email);
  }
  return 'applied';
}

/**
 * POST /api/webhooks/brevo/:token — événements de délivrabilité Brevo.
 *
 * Brevo poste soit un objet, soit un tableau d'événements. La réponse est
 * toujours 204 dès que le jeton est valide, même pour un message inconnu :
 * un 4xx déclencherait des réessais inutiles, puis la désactivation du webhook
 * côté Brevo.
 *
 * Exporté pour être testé sans démarrer de serveur.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function handleBrevoWebhook(req, res) {
  const expected = getBrevo().webhookToken;
  if (!expected || !safeEqual(req.params?.token, expected)) {
    return res.status(403).json({ error: 'JETON_INVALIDE' });
  }
  const body = req.body;
  const events = Array.isArray(body) ? body : (Array.isArray(body?.items) ? body.items : [body]);
  let applied = 0;
  for (const ev of events.slice(0, 200)) {
    try { if (applyEvent(ev) === 'applied') applied += 1; } catch { /* un événement illisible n'interrompt pas le lot */ }
  }
  if (applied) console.log(`[webhook:brevo] ${applied} événement(s) de délivrabilité appliqué(s)`);
  return res.status(204).end();
}

webhooksRouter.post(
  '/brevo/:token',
  // Brevo n'envoie qu'une poignée d'événements par message ; 600/min laisse une
  // marge confortable pour une campagne tout en bornant l'abus.
  rateLimit({ windowMs: 60_000, max: 600 }),
  handleBrevoWebhook
);
