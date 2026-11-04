import { useState } from 'react';

// Bloc « Code d'accès porte » (PIN UniFi Access) sur le détail d'une réservation.
// Grisé si la réservation est annulée ou déjà passée. Bouton « Copier ».
export default function AccessPinBlock({ reservation }) {
  const [copied, setCopied] = useState(false);
  const pin = reservation?.access_pin;
  if (!pin) return null;

  const expired = reservation.status === 'cancelled' || new Date(reservation.end_at).getTime() < Date.now();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* presse-papier indisponible */ }
  };

  return (
    <div className={`voucher ${expired ? 'voucher-off' : ''}`}>
      <div className="voucher-label">
        Code d'accès porte
        {expired && <span className="voucher-tag">expiré</span>}
      </div>

      <div className="voucher-row">
        <code className="voucher-code">{pin}</code>
        {!expired && (
          <button type="button" className="outline small" onClick={copy}>
            {copied ? '✓ Copié' : 'Copier'}
          </button>
        )}
      </div>

      {!expired && (
        <div className="voucher-hint">
          Composez ce code sur le <strong>digicode</strong> de la porte pour entrer. Il ne fonctionne que
          <strong> pendant votre créneau réservé</strong> (avec une courte marge avant et après).
        </div>
      )}
    </div>
  );
}
