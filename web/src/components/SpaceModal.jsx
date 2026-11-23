import Photo from './Photo.jsx';
import { eur, spacePrice, spaceModes } from '../price.js';
import ReservationNotice from './ReservationNotice.jsx';

// Fenêtre détaillée d'un espace (depuis la landing) : photo, descriptif complet,
// prestations incluses, et appel à l'action fondé sur les DEUX modes de l'espace
// (cf. price.js `spaceModes`) :
//   • en ligne + devis : l'utilisateur choisit (réservation ponctuelle / devis) ;
//   • en ligne seul    : réservation en ligne ;
//   • devis seul       : demande de devis, prix masqué ;
//   • aucun            : libre-service si CONFIDENTIAL, sinon aucun bouton.
export default function SpaceModal({ space, photoSrc, onClose, onReserve, onDevis }) {
  const amenities = (space.amenities || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const { online, quote } = spaceModes(space);
  const isBoth = online && quote;
  const isDevis = quote && !online;
  const isLibreService = !online && !quote && space.category === 'CONFIDENTIAL';
  // Prix d'appel : « À partir de … » dès qu'il existe plusieurs tarifs. L'open
  // space n'est jamais affiché à l'heure (cf. price.js). Masqué en mode devis seul.
  const p = spacePrice(space);
  const priceLabel = p.kind === 'price'
    ? (p.from ? `À partir de ${eur(p.min)}` : eur(p.min))
    : p.kind === 'libre' ? 'Libre-service'
    : '';
  // Sans tarif exploitable (espace sans mode, hors libre-service) : pas de bloc
  // prix, donc pas de séparateur orphelin.
  const showPrice = !isDevis && priceLabel !== '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal space-modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            <span className="dot" style={{ background: space.color }} />{space.name}
          </h2>
          <button className="ghost" style={{ color: 'var(--ink)', border: '1px solid var(--line)' }} onClick={onClose}>✕</button>
        </div>

        <Photo src={photoSrc} alt={space.name} className="space-modal-photo" caption={space.name} />

        <div className="flex-between" style={{ margin: '14px 0' }}>
          <span className="badge grey">
            {space.category === 'PRIVATE_OFFICE' ? 'Bureau privé' : space.kind === 'room' ? 'Salle privative' : 'Open-space'}
          </span>
          <span className="muted seats">
            {isDevis ? 'Privatisation longue durée'
              : isBoth ? 'Ponctuel ou longue durée'
              : space.kind === 'room' ? 'Réservation exclusive'
              : `Jusqu'à ${space.capacity} places`}
            {/* Devis seul : aucune notion de prix affichée. */}
            {showPrice && <> · <strong style={{ color: 'var(--navy)' }}>{priceLabel}</strong></>}
          </span>
        </div>

        {space.description && <p className="lead" style={{ fontSize: 15 }}>{space.description}</p>}

        {amenities.length > 0 && (
          <>
            <h3 style={{ margin: '16px 0 10px' }}>Ce qui est inclus</h3>
            <ul className="amenities-list">
              {amenities.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </>
        )}

        {isDevis && (
          <div className="alert" style={{ marginTop: 16, background: 'rgba(59,130,246,0.06)', border: '1px solid var(--line)' }}>
            Cet espace est accessible <strong>exclusivement sur devis</strong> : contrat de privatisation
            sur mesure (trimestre ou année). Laissez-nous votre besoin, nous vous recontactons rapidement.
          </div>
        )}
        {isLibreService && (
          <div className="alert" style={{ marginTop: 16, background: 'rgba(59,130,246,0.06)', border: '1px solid var(--line)' }}>
            Accès <strong>libre-service</strong> sur place, sans réservation ni paiement en ligne.
          </div>
        )}
        {isBoth && (
          <div className="alert" style={{ marginTop: 16, background: 'rgba(59,130,246,0.06)', border: '1px solid var(--line)' }}>
            Deux façons d'en profiter : <strong>réservez ponctuellement</strong> en ligne, à l'unité
            (demi-journée ou journée), ou <strong>demandez un devis</strong> pour un contrat de
            longue durée (trimestre ou année).
          </div>
        )}
        {online && (
          <ReservationNotice
            variant={space.category === 'MEETING_ROOM' ? 'salle' : 'open_space'}
            style={{ marginTop: 16 }}
          />
        )}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="outline" onClick={onClose}>Fermer</button>
          {quote && (
            <button className={isBoth ? 'outline' : undefined} onClick={onDevis}>Demander un devis</button>
          )}
          {online && <button onClick={onReserve}>Réserver cet espace</button>}
        </div>
      </div>
    </div>
  );
}
