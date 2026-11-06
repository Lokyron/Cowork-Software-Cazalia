// Point d'attention : la réservation du créneau sur la plateforme est
// obligatoire pour tout le monde (y compris les abonnés) et pour toute durée de
// salle. Objectif : garantir une place à chacun et le confort de tous dans le
// local. Affiché sur les fiches espaces/abonnements, le tunnel de réservation,
// le récapitulatif et l'espace membre.
//
// `variant` adapte le message au contexte ; `compact` réduit les marges pour
// une insertion dans une carte existante.
const TEXTS = {
  abonnement:
    "Votre abonnement vous donne l'accès et le tarif, mais ne réserve pas votre place : "
    + 'réservez chaque créneau sur votre espace avant de venir.',
  open_space:
    'Pour garantir une place à chacun, la réservation du créneau est obligatoire avant de '
    + 'venir, y compris avec un abonnement.',
  salle:
    'La salle de réunion se réserve obligatoirement sur votre espace, pour toute durée '
    + '(heure, demi-journée ou journée).',
  generic:
    'Pour garantir une place à chacun, la réservation du créneau est obligatoire avant de '
    + 'venir, même avec un abonnement (salle de réunion incluse, pour toute durée).',
};

export default function ReservationNotice({ variant = 'generic', compact = false, style }) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: compact ? '10px 12px' : '12px 14px',
        borderRadius: 12,
        background: 'rgba(180, 83, 9, 0.08)',
        border: '1px solid rgba(180, 83, 9, 0.25)',
        ...style,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.3 }}>📌</span>
      <div>
        <strong style={{ color: 'var(--amber)' }}>Réservation obligatoire</strong>
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 13, lineHeight: 1.5 }}>
          {TEXTS[variant] || TEXTS.generic}
        </p>
      </div>
    </div>
  );
}
