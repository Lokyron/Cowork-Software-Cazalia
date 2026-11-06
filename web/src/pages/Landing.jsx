import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { eur, spacePrice } from '../price.js';
import Photo from '../components/Photo.jsx';
import SpaceModal from '../components/SpaceModal.jsx';
import DevisModal from '../components/DevisModal.jsx';
import PublicHeader from '../components/PublicHeader.jsx';

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState([]);
  const [gallery, setGallery] = useState([]); // photos du carrousel (dossier dédié)
  // Photos réglées depuis l'administration. Tant qu'aucune n'est déposée, on
  // garde celles livrées avec l'application : la page n'est jamais vide.
  const [media, setMedia] = useState({ hero: null, presentation: null });
  const [openSpace, setOpenSpace] = useState(null); // { space, photoSrc } pour la modale
  const [devis, setDevis] = useState(false); // modale « Demander un devis » (Bureau privé)

  useEffect(() => {
    api.get('/spaces').then((r) => setSpaces(r.spaces)).catch(() => {});
    api.get('/media').then((r) => {
      setGallery(r.carousel || []);
      setMedia({ hero: r.hero || null, presentation: r.presentation || null });
    }).catch(() => {});
  }, []);

  const goReserve = () => navigate(user ? '/reserver' : '/login');

  return (
    <div className="landing">
      <PublicHeader user={user} />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <Photo src={media.hero || '/images/hero.jpg'} alt="Notre espace de co-working" className="hero-img" caption="Photo d'ambiance à venir" />
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
            <Link to="/tarifs" className="btn-secondary">Voir les abonnements</Link>
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
          <Photo src={media.presentation || '/images/presentation.jpg'} alt="Intérieur de l'espace" className="split-photo" caption="Photo du lieu à venir" />
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
            const photoSrc = s.photo
              ? `/api/media/${encodeURIComponent(s.photo)}`
              : `/images/espace-${i + 1}.jpg`;
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
                    <span className="price">
                      {/* Prix d'appel « À partir de … » ; Bureau privé : aucun prix. */}
                      {(() => {
                        const p = spacePrice(s);
                        if (p.kind === 'price') return <>{p.from && <small>À partir de </small>}{eur(p.min)}</>;
                        if (p.kind === 'libre') return <small>Libre-service</small>;
                        if (p.kind === 'devis') return null;
                        return <small>sur devis</small>;
                      })()}
                    </span>
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
            {/* Photos réglées dans l'admin (API /media), dupliquées pour une boucle sans couture. */}
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
            <p>
              <a
                href="https://www.google.com/maps/search/?api=1&query=99%20rue%20du%20Faubourg%20Boutonnet%2C%2034090%20Montpellier"
                target="_blank"
                rel="noopener noreferrer"
              >
                99 rue du Faubourg Boutonnet<br />34090 Montpellier
              </a>
            </p>
          </div>
          <div className="card info-card">
            <h3>Contact</h3>
            <p><a href="tel:+33766211483">07 66 21 14 83</a><br /><a href="mailto:contact@cazalia.fr">contact@cazalia.fr</a></p>
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
          <Link to="/tarifs">Tarifs</Link>
          <Link to="/cgu">CGU &amp; mentions légales</Link>
          <Link to="/cgv">CGV</Link>
          <Link to="/cgu#confidentialite">Confidentialité</Link>
          <Link to="/reclamation">Réclamation</Link>
        </nav>
        <span className="muted">© {new Date().getFullYear()} — Espace de co-working</span>
      </footer>

      {openSpace && (
        <SpaceModal
          space={openSpace.space}
          photoSrc={openSpace.photoSrc}
          onClose={() => setOpenSpace(null)}
          onReserve={goReserve}
          onDevis={() => { setOpenSpace(null); setDevis(true); }}
        />
      )}

      {devis && <DevisModal onClose={() => setDevis(false)} />}
    </div>
  );
}
