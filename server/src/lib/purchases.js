import { db } from '../db.js';
import { topUp } from './wallet.js';

// Achats de crédits Stripe : enregistrement de la session, puis crédit du
// portefeuille à la confirmation de paiement — une seule fois (idempotence).

const insertPending = db.prepare(
  `INSERT INTO credit_purchases (user_id, session_id, credits, amount_eur_cents, status)
   VALUES (@user_id, @session_id, @credits, @amount_eur_cents, 'pending')`
);
const findBySession = db.prepare(`SELECT * FROM credit_purchases WHERE session_id = ?`);
const markPaid = db.prepare(
  `UPDATE credit_purchases
      SET status = 'paid', payment_intent = @payment_intent, credited_tx_id = @credited_tx_id,
          updated_at = datetime('now')
    WHERE id = @id AND status != 'paid'`
);

/**
 * Enregistre une session Checkout en attente de paiement.
 * @param {{userId:number, sessionId:string, credits:number, amountEurCents:number}} p
 * @returns {void}
 */
export function recordPending({ userId, sessionId, credits, amountEurCents }) {
  insertPending.run({ user_id: userId, session_id: sessionId, credits, amount_eur_cents: amountEurCents });
}

/**
 * Crédite le portefeuille pour une session payée, de façon IDEMPOTENTE.
 *
 * Tout se joue dans une transaction : on relit la ligne, on refuse si elle est
 * déjà 'paid', sinon on passe l'écriture de crédit puis on marque 'paid'. Deux
 * livraisons du même événement (Stripe réessaie) ne créditent donc qu'une fois.
 * Si la session n'a pas été enregistrée au checkout (cas limite), on la crée.
 *
 * @param {{sessionId:string, paymentIntent?:string|null, userId:number,
 *          credits:number, amountEurCents:number}} p
 * @returns {{credited:boolean, alreadyProcessed:boolean}}
 */
export const fulfillPurchase = db.transaction(({ sessionId, paymentIntent = null, userId, credits, amountEurCents }) => {
  let row = findBySession.get(sessionId);
  if (!row) {
    insertPending.run({ user_id: userId, session_id: sessionId, credits, amount_eur_cents: amountEurCents });
    row = findBySession.get(sessionId);
  }
  if (row.status === 'paid') return { credited: false, alreadyProcessed: true };

  const { transactionId } = topUp({
    userId: row.user_id,
    amount: row.credits,
    createdBy: row.user_id,
    note: 'Recharge en ligne (Stripe)',
    amountEurCents: row.amount_eur_cents,
  });
  markPaid.run({ id: row.id, payment_intent: paymentIntent, credited_tx_id: transactionId });
  return { credited: true, alreadyProcessed: false };
});
