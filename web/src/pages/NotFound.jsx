import BackLink from '../components/BackLink.jsx';
import Seo from '../components/Seo.jsx';

// Page 404. Le serveur répond HTTP 200 (fallback SPA sur index.html) : c'est
// le `noindex` posé par <Seo> qui empêche l'indexation, pas le code de statut.
export default function NotFound() {
  return (
    <div className="auth-wrap">
      <Seo title="Page introuvable | Cazalia" description="Cette page n’existe pas ou a été déplacée." noindex />
      <div className="card" style={{ textAlign: 'center' }}>
        <h1 style={{ marginTop: 8 }}>Page introuvable</h1>
        <p className="subtitle">
          La page que vous cherchez n'existe pas ou a été déplacée.
        </p>
        <BackLink to="/" label="Retour à l'accueil" />
      </div>
    </div>
  );
}
