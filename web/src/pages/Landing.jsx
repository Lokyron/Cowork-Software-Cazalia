import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import Photo from '../components/Photo.jsx';
import SpaceModal from '../components/SpaceModal.jsx';

// Liens d'ancrage de la barre publique.
const SECTIONS = [
  { id: 'presentation', label: 'Le lieu' },
  { id: 'espaces', label: 'Les espaces' },
  { id: 'galerie', label: 'Galerie' },
  { id: 'infos', label: 'Infos pratiques' },
];

function PublicHeader({ user }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`public-header ${scrolled ? 'scrolled' : ''}`}>
      <div className="public-header-inner">
        <div className="brand">
          <img src="/images/logo-lockup-white.svg" className="brand-full" alt="Cazalia" />
        </div>
        <nav className="public-links">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>{s.label}</a>
          ))}
        </nav>
        <div className="public-cta">
          {user ? (
            <Link to="/reserver" className="btn-link">Mon espace →</Link>
          ) : (
            <Link to="/login" className="btn-link">Se connecter</Link>
          )}
        </div>
      </div>
    </header>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState([]);
  const [gallery, setGallery] = useState([]); // photos du carrousel (dossier dédié)
  const [openSpace, setOpenSpace] = useState(null); // { space, photoSrc } pour la modale

  useEffect(() => {
    api.get('/spaces').then((r) => setSpaces(r.spaces)).catch(() => {});
    api.get('/gallery').then((r) => setGallery(r.images || [])).catch(() => {});
  }, []);

  const goReserve = () => navigate(user ? '/reserver' : '/login');

  return (
    <div className="landing">
      <PublicHeader user={user} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <Photo src="/images/hero.jpg" alt="Notre espace de co-working" className="hero-img" caption="Photo d'ambiance à venir" />
        <div className="hero-overlay" />
        <div className="hero-content">
          <span className="eyebrow">Espace de co-working</span>
          <h1>Travaillez mieux dans un lieu qui <em>vous ressemble</em></h1>
          <p>
            Réservez en quelques clics votre espace de travail pensé pour la concentration,
            la productivité et le bien-être des indépendants.
          </p>
          <div className="hero-actions">
            <button onClick={goReserve}>Réserver une place</button>
            <a href="#presentation" className="btn-secondary">Découvrir le lieu</a>
          </div>
        </div>
      </section>

      {/* ── Présentation ─────────────────────────────────────────────────── */}
      <section id="presentation" className="section">
        <div className="split">
          <div className="split-text">
            <span className="eyebrow dark">Le lieu</span>
            <h2 className="big">Le charme d'un lieu chaleureux, le confort d'un espace professionnel.</h2>
            <p className="lead">
              Café à volonté, fibre, salle de réunion, open space et bureau privatif :
              vous n'avez plus qu'à vous installer.
            </p>
            <ul className="features">
              <li>Internet haut débit & prise à chaque poste</li>
              <li>Salles privatives réservables à l'heure</li>
              <li>Cuisine, café et thé inclus</li>
              <li>Accès souple, à la carte ou au forfait</li>
            </ul>
          </div>
          <Photo src="/images/presentation.jpg" alt="Intérieur de l'espace" className="split-photo" caption="Photo du lieu à venir" />
        </div>
      </section>

      {/* ── Espaces (données réelles de l'API) ───────────────────────────── */}
      <section id="espaces" className="section alt">
        <div className="section-head">
          <span className="eyebrow dark">Les espaces</span>
          <h2 className="big">Choisissez l'espace qui vous correspond.</h2>
        </div>
        <div className="space-cards">
          {spaces.length === 0 && <p className="muted">Les espaces seront bientôt présentés ici.</p>}
          {spaces.map((s, i) => {
            const photoSrc = `/images/espace-${i + 1}.jpg`;
            return (
              <article
                key={s.id}
                className="card space-card space-pick"
                onClick={() => setOpenSpace({ space: s, photoSrc })}
              >
                <Photo src={photoSrc} alt={s.name} className="space-photo" caption={s.name} />
                <div className="space-card-body">
                  <div className="flex-between">
                    <strong><span className="dot" style={{ background: s.color }} />{s.name}</strong>
                    <span className="badge grey">{s.kind === 'room' ? 'Salle privative' : 'Open-space'}</span>
                  </div>
                  <p className="muted" style={{ margin: '8px 0 14px' }}>
                    {s.kind === 'room'
                      ? 'Réservation exclusive, idéale pour un appel ou une réunion.'
                      : `Jusqu'à ${s.capacity} places sur ce créneau.`}
                  </p>
                  <div className="flex-between">
                    <span className="price">{s.credits_per_hour} <small>crédits/h</small></span>
                    <button className="small outline" onClick={(e) => { e.stopPropagation(); setOpenSpace({ space: s, photoSrc }); }}>
                      Voir le détail →
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* ── Galerie ──────────────────────────────────────────────────────── */}
      <section id="galerie" className="section">
        <div className="section-head">
          <span className="eyebrow dark">Galerie</span>
          <h2 className="big">Un aperçu en images.</h2>
        </div>
        {gallery.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center' }}>Les photos seront bientôt présentées ici.</p>
        ) : (
          <div className="carousel">
            {/* Photos lues depuis le dossier dédié (API /gallery), dupliquées pour une boucle sans couture. */}
            <div className="carousel-track">
              {[...gallery, ...gallery].map((src, i) => (
                <Photo key={i} src={src} alt={`Photo ${(i % gallery.length) + 1}`} className="carousel-item" caption="Photo" />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Infos pratiques ──────────────────────────────────────────────── */}
      <section id="infos" className="section alt">
        <div className="info-grid">
          <div className="card info-card">
            <h3>Horaires</h3>
            <p>Lun – Ven : 8h30 – 19h30<br />Samedi : 9h – 13h<br />Dimanche : fermé</p>
          </div>
          <div className="card info-card">
            <h3>Adresse</h3>
            <p>99 rue du Faubourg Boutonnet<br />34090 Montpellier</p>
          </div>
          <div className="card info-card">
            <h3>Contact</h3>
            <p>[Téléphone]<br />[email@exemple.fr]</p>
          </div>
        </div>
      </section>

      {/* ── CTA final ────────────────────────────────────────────────────── */}
      <section className="cta-final">
        <h2>Prêt à réserver votre place ?</h2>
        <p>Créez votre compte en une minute et réservez votre premier créneau.</p>
        <div className="hero-actions">
          <button onClick={goReserve}>{user ? 'Accéder à mon espace' : 'Créer un compte'}</button>
          {!user && <Link to="/login" className="btn-secondary">J'ai déjà un compte</Link>}
        </div>
      </section>

      <footer className="landing-footer">
        <span>Cazalia</span>
        <nav className="footer-links">
          <Link to="/cgu">CGU &amp; mentions légales</Link>
          <Link to="/cgu#confidentialite">Confidentialité</Link>
        </nav>
        <span className="muted">© {new Date().getFullYear()} — Espace de co-working</span>
      </footer>

      {openSpace && (
        <SpaceModal
          space={openSpace.space}
          photoSrc={openSpace.photoSrc}
          onClose={() => setOpenSpace(null)}
          onReserve={goReserve}
        />
      )}
    </div>
  );
}
