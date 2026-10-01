import { useState } from 'react';
import { Link } from 'react-router-dom';

// Bandeau (fermable) invitant à activer la 2FA. Masqué pour la session courante
// une fois fermé, et n'apparaît pas si la 2FA est déjà active (géré par le parent).
export default function TwoFactorBanner() {
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('hide2faBanner') === '1');
  if (hidden) return null;
  const close = () => { sessionStorage.setItem('hide2faBanner', '1'); setHidden(true); };

  return (
    <div className="topbanner">
      <span>🔒 Sécurisez votre compte : activez la <strong>double authentification</strong> (2FA).</span>
      <span className="topbanner-actions">
        <Link to="/mon-compte" onClick={close}>Activer</Link>
        <button className="topbanner-close" onClick={close} aria-label="Fermer le bandeau">✕</button>
      </span>
    </div>
  );
}
