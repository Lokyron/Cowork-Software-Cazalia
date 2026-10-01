import Photo from './Photo.jsx';

// Fenêtre détaillée d'un espace (depuis la landing) : photo, descriptif complet,
// prestations incluses, et bouton pour réserver.
export default function SpaceModal({ space, photoSrc, onClose, onReserve }) {
  const amenities = (space.amenities || '').split('\n').map((s) => s.trim()).filter(Boolean);

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
          <span className="badge grey">{space.kind === 'room' ? 'Salle privative' : 'Open-space'}</span>
          <span className="muted seats">
            {space.kind === 'room' ? 'Réservation exclusive' : `Jusqu'à ${space.capacity} places`} ·{' '}
            <strong style={{ color: 'var(--navy)' }}>{space.credits_per_hour} crédits/h</strong>
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

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="outline" onClick={onClose}>Fermer</button>
          <button onClick={onReserve}>Réserver cet espace</button>
        </div>
      </div>
    </div>
  );
}
