import { useAuth } from '../auth.jsx';
import ChangePassword from '../components/ChangePassword.jsx';

// Écran bloquant à la première connexion d'un compte créé par l'admin :
// l'utilisateur doit remplacer le mot de passe par défaut avant d'accéder à l'app.
export default function ForcePasswordChange() {
  const { user, logout, refresh } = useAuth();

  return (
    <div className="auth-wrap" style={{ maxWidth: 460 }}>
      <div className="card" style={{ marginBottom: 14 }}>
        <h1>Bienvenue {user?.display_name}</h1>
        <p className="subtitle" style={{ margin: 0 }}>
          Votre compte a été créé avec un mot de passe provisoire.
          Pour des raisons de sécurité, choisissez votre propre mot de passe pour continuer.
        </p>
      </div>

      {/* Après succès, on rafraîchit la session : le drapeau tombe → accès à l'app. */}
      <ChangePassword forced onDone={refresh} />

      <p className="muted" style={{ textAlign: 'center', marginTop: 14, fontSize: 14 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Se déconnecter</a>
      </p>
    </div>
  );
}
