import { toDate } from '../time.js';

// Fenêtre de remboursement : 24 h avant le début du créneau (alignée sur REFUND_WINDOW_HOURS côté serveur).
const REFUND_WINDOW_MS = 24 * 3600 * 1000;

// Bloc de confirmation avant annulation : pose la question et annonce la conséquence
// sur le remboursement AVANT le clic. Le serveur reste seul juge du remboursement.
function CancelConfirm({ reservation: r, busy, onConfirm, onKeep }) {
  const inWindow = toDate(r.start_at).getTime() - Date.now() > REFUND_WINDOW_MS;
  const m = r.payment_method;
  const included = m === 'SUBSCRIPTION_QUOTA' || m === 'SUBSCRIPTION_UNLIMITED';
  // Réservation ponctuelle réglée à l'unité (anciennes lignes sans payment_method : on se fie au statut de paiement).
  const oneOff = m === 'STRIPE_ONE_OFF' || (!m && r.payment_status === 'paid' && (r.price_cents || 0) > 0);
  let consequence;
  if (included) {
    consequence = "Cette réservation est incluse dans votre abonnement : elle ne donne pas lieu à un remboursement."
      + (m === 'SUBSCRIPTION_QUOTA' ? ' Votre jour de quota vous sera restitué.' : '');
  } else if (!oneOff) {
    consequence = "Cette réservation n'a pas été réglée à l'unité : aucun remboursement n'est dû.";
  } else if (inWindow) {
    consequence = "Seules les réservations ponctuelles réglées à l'unité sont remboursables. L'annulation intervenant plus de 24 h avant le début du créneau, vous pourrez demander le remboursement intégral à la gestionnaire.";
  } else {
    consequence = "Seules les réservations ponctuelles réglées à l'unité sont remboursables. Le créneau débutant dans moins de 24 h, aucun remboursement ne sera effectué (le remboursement est intégral ou nul, jamais partiel).";
  }
  return (
    <div className="alert error" style={{ marginTop: 12, textAlign: 'left' }}>
      <strong>Êtes-vous sûr de vouloir annuler cette réservation ?</strong>
      <p style={{ margin: '6px 0 10px' }}>{consequence}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="danger small" onClick={onConfirm} disabled={busy}>
          {busy ? 'Annulation…' : "Confirmer l'annulation"}
        </button>
        <button className="outline small" onClick={onKeep} disabled={busy}>Garder ma réservation</button>
      </div>
    </div>
  );
}

export default CancelConfirm;
