import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ResendVerification } from '../components/EmailVerifyBanner.jsx';
import BackLink from '../components/BackLink.jsx';

// Page publique ouverte depuis le lien de l'e-mail de vérification (/verifier-email?token=...).
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user, refresh } = useAuth();

  const [state, setState] = useState('checking'); // checking | done | invalid
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) { setState('invalid'); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        // Lecture d'abord (affiche l'adresse), consommation ensuite.
        const info = await api.get(`/auth/verify-email/${encodeURIComponent(token)}`);
        if (cancelled) return;
        setEmail(info.email || '');
        await api.post('/auth/verify-email', { token });
        if (cancelled) return;
        setState('done');
        // Le blocage doit disparaître sans reconnexion : on recharge l'état utilisateur.
        refresh();
      } catch {
        if (cancelled) return;
        // Lien déjà utilisé alors que le compte connecté est vérifié : pas une erreur.
        try {
          const { user: me } = await api.get('/auth/me');
          if (!cancelled && me?.email_verified) { setState('done'); refresh(); return; }
        } catch { /* on retombe sur l'état « lien invalide » */ }
        if (!cancelled) setState('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, [token, refresh]);

  return (
    <div className="auth-wrap">
      <div className="card">
        <BackLink to="/" label="Retour à l'accueil" />
        <h1>Confirmation de l'adresse e-mail</h1>

        {state === 'checking' && <p className="muted">Vérification du lien…</p>}

        {state === 'done' && (
          <>
            <div className="alert ok">
              Merci, votre adresse{email ? <> <strong>{email}</strong></> : ''} est confirmée. Vous pouvez réserver.
            </div>
            <Link to={user ? '/mon-espace' : '/login'}>
              <button style={{ width: '100%' }}>{user ? 'Accéder à mon espace' : 'Se connecter'}</button>
            </Link>
          </>
        )}

        {state === 'invalid' && (
          <>
            <div className="alert error">Ce lien est invalide, expiré ou déjà utilisé.</div>
            {user ? (
              <p className="muted" style={{ fontSize: 14 }}>
                Demandez un nouveau lien : <ResendVerification />
              </p>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>
                Connectez-vous pour demander un nouveau lien. <Link to="/login">Se connecter</Link>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
