import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

// En-tête public (landing + page Tarifs). Transparent au-dessus du hero sombre,
// il passe en fond opaque au défilement. `solid` force ce fond opaque dès le
// chargement : utile sur une page claire (Tarifs) où le texte blanc serait
// sinon illisible en haut de page.
const SECTIONS = [
  { id: 'presentation', label: 'Le lieu' },
  { id: 'espaces', label: 'Les espaces' },
  { id: 'galerie', label: 'Galerie' },
  { id: 'infos', label: 'Infos pratiques' },
];

export default function PublicHeader({ solid = false }) {
  const { user } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`public-header ${solid || scrolled ? 'scrolled' : ''}`}>
      <div className="public-header-inner">
        <Link to="/" className="brand">
          <img src="/images/logo-lockup-white.svg" className="brand-full" alt="Cazalia" />
        </Link>
        <nav className="public-links">
          {/* Ancres de la landing : préfixées « / » pour fonctionner depuis une
              autre page (navigation vers l'accueil + défilement à l'ancre). */}
          {SECTIONS.map((s) => (
            <a key={s.id} href={`/#${s.id}`}>{s.label}</a>
          ))}
          <Link to="/tarifs">Tarifs</Link>
        </nav>
        <div className="public-cta">
          {user ? (
            <Link to="/mon-espace" className="btn-link">Mon espace →</Link>
          ) : (
            <Link to="/login" className="btn-link">Se connecter</Link>
          )}
        </div>
      </div>
    </header>
  );
}
