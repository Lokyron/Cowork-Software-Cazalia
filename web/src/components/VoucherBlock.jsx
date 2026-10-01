import { useState } from 'react';

// Nom du réseau Wi-Fi invité diffusé sur place.
const WIFI_SSID = 'CAZALIA-BOUTONNET';

// Bloc « Accès Wi-Fi invité » affiché sur le détail d'une réservation (client et admin).
// Grisé si la réservation est annulée ou déjà passée. Bouton « Copier » avec retour visuel.
export default function VoucherBlock({ reservation }) {
  const [copied, setCopied] = useState(false);
  const code = reservation?.voucher_code;
  if (!code) return null;

  const expired = reservation.status === 'cancelled' || new Date(reservation.end_at).getTime() < Date.now();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard indisponible : on ignore */ }
  };

  return (
    <div className={`voucher ${expired ? 'voucher-off' : ''}`}>
      <div className="voucher-label">
        Accès Wi-Fi invité
        {expired && <span className="voucher-tag">expiré</span>}
      </div>

      <div className="voucher-net">
        Réseau&nbsp;: <strong>{WIFI_SSID}</strong>
      </div>

      <div className="voucher-row">
        <code className="voucher-code">{code}</code>
        {!expired && (
          <button type="button" className="outline small" onClick={copy}>
            {copied ? '✓ Copié' : 'Copier'}
          </button>
        )}
      </div>

      {!expired && (
        <div className="voucher-hint">
          Connectez-vous au réseau <strong>{WIFI_SSID}</strong>, puis saisissez ce code sur la page d'accueil
          qui s'ouvre automatiquement. Utilisable sur <strong>tous vos appareils</strong> (ordinateur, téléphone,
          tablette), valable <strong>24 h</strong> à partir de la première connexion. Bonne session&nbsp;!
        </div>
      )}
    </div>
  );
}
