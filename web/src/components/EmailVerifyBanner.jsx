import { useState } from 'react';
import { api, msg } from '../api.js';

// Bouton « Renvoyer le lien » de vérification d'adresse e-mail, avec retour visible
// (envoyé / erreur) et protection contre le double-clic. Partagé par le bandeau et
// par le tunnel de réservation.
export function ResendVerification({ className = 'outline' }) {
  const [state, setState] = useState('idle'); // idle | busy | sent | error
  const [error, setError] = useState('');

  const resend = async () => {
    if (state === 'busy') return;
    setState('busy');
    setError('');
    try {
      await api.post('/auth/resend-verification');
      setState('sent');
    } catch (err) {
      setError(msg(err.code));
      setState('error');
    }
  };

  return (
    <span className="resend-verify">
      <button type="button" className={className} onClick={resend} disabled={state === 'busy'}>
        {state === 'busy' ? 'Envoi…' : state === 'sent' ? 'Renvoyer à nouveau' : 'Renvoyer le lien'}
      </button>
      {state === 'sent' && <span role="status"> Lien envoyé, pensez à vérifier vos courriers indésirables.</span>}
      {state === 'error' && <span role="alert"> {error}</span>}
    </span>
  );
}

// Bandeau de l'espace membre : l'adresse n'est pas encore confirmée, les
// réservations sont suspendues. Pas de bouton de fermeture : il disparaît tout
// seul à la validation (l'état utilisateur est rafraîchi par la page de validation).
export default function EmailVerifyBanner() {
  return (
    <div className="topbanner" role="region" aria-label="Adresse e-mail à confirmer">
      <span>
        ✉️ Confirmez votre adresse e-mail pour pouvoir réserver : cliquez sur le lien reçu à l'inscription.
      </span>
      <span className="topbanner-actions">
        <ResendVerification className="topbanner-btn" />
      </span>
    </div>
  );
}
