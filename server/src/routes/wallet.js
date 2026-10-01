import { Router } from 'express';
import { db } from '../db.js';
import { getBalance, getHistory, getLedgerBetween } from '../lib/wallet.js';
import { streamInvoicePdf } from '../lib/invoice.js';
import { parsePeriod } from '../lib/time.js';
import { requireAuth, sendBusinessError } from '../middleware.js';

export const walletRouter = Router();

/**
 * GET /api/wallet/me — solde et historique du portefeuille de l'appelant.
 * L'identifiant provient de la SESSION, jamais d'un paramètre : il n'existe pas
 * de moyen de consulter le portefeuille d'un autre membre (IDOR impossible).
 *
 * @returns 200 `{balance, history}` · 401 `NON_AUTHENTIFIE`
 */
walletRouter.get('/wallet/me', requireAuth, (req, res) => {
  res.json({
    balance: getBalance(req.user.id),
    history: getHistory(req.user.id),
  });
});

const memberStmt = db.prepare(
  `SELECT id, email, display_name, first_name, last_name, phone FROM users WHERE id = ?`
);

/**
 * GET /api/invoice?from&to — relevé PDF des transactions de l'appelant.
 * La période est validée AVANT d'émettre le moindre en-tête : une erreur
 * survenant pendant la génération produirait un PDF tronqué.
 *
 * @returns 200 `application/pdf` · 400 `PERIODE_INVALIDE` · 401 `NON_AUTHENTIFIE`
 */
walletRouter.get('/invoice', requireAuth, (req, res) => {
  let period;
  try {
    period = parsePeriod(req.query.from, req.query.to);
  } catch (err) {
    return sendBusinessError(res, err);
  }
  const member = memberStmt.get(req.user.id);
  const transactions = getLedgerBetween(req.user.id, period.fromIso, period.toIso);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="releve-cowork.pdf"');
  streamInvoicePdf(res, { member, transactions, fromIso: period.fromIso, toIso: period.toIso });
});
