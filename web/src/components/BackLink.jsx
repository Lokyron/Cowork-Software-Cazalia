import { Link, useNavigate } from 'react-router-dom';

// Lien/bouton de navigation « retour ».
//  - `to` fourni  → lien vers cette route (ex. retour à l'accueil).
//  - sinon        → retour en arrière dans l'historique.
export default function BackLink({ to, label = 'Retour', className = 'backlink' }) {
  const navigate = useNavigate();
  const inner = <><span aria-hidden="true">←</span> {label}</>;
  if (to) return <Link to={to} className={className}>{inner}</Link>;
  return (
    <button type="button" className={className} onClick={() => navigate(-1)}>
      {inner}
    </button>
  );
}
