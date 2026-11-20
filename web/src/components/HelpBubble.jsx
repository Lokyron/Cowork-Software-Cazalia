import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ContactModal from './ContactModal.jsx';

// Pages sur lesquelles la bulle d'aide est masquée : authentification, maquette
// du tunnel d'achat et espace d'administration (tout /admin/*).
const HIDDEN_PATHS = ['/login', '/reset-password', '/mot-de-passe-oublie', '/test-checkout-flow'];
const isHidden = (pathname) => HIDDEN_PATHS.includes(pathname) || pathname === '/admin' || pathname.startsWith('/admin/');

// Icônes SVG inline (pas de librairie d'icônes).
const svgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
const IconChat = ({ size = 26 }) => (
  <svg {...svgProps} width={size} height={size}>
    <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 20.5l1.6-4.9A8.5 8.5 0 1 1 21 11.5z" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4" />
    <path d="M12 15.8h.01" />
  </svg>
);
const IconClose = () => (
  <svg {...svgProps} width="24" height="24"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const IconMail = () => (
  <svg {...svgProps} width="18" height="18"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
);
const IconAlert = () => (
  <svg {...svgProps} width="18" height="18"><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18h.01" /></svg>
);
const IconPhone = () => (
  <svg {...svgProps} width="18" height="18"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></svg>
);
const IconAt = () => (
  <svg {...svgProps} width="18" height="18"><circle cx="12" cy="12" r="4" /><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" /></svg>
);

// Bulle d'aide flottante (bas droite, toutes pages) : relais vers le formulaire
// de contact, la page de réclamation, le téléphone et l'e-mail.
export default function HelpBubble() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState(false);
  const rootRef = useRef(null);
  const btnRef = useRef(null);

  // Ferme le panneau (Échap ou clic en dehors) tant qu'il est ouvert.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Navigation vers une page masquée : on referme tout.
  useEffect(() => { setOpen(false); }, [pathname]);

  if (isHidden(pathname)) return null;

  const close = () => setOpen(false);
  const openContact = () => { setOpen(false); setContact(true); };

  return (
    <>
      <div ref={rootRef}>
        <button
          ref={btnRef}
          type="button"
          className="help-bubble"
          aria-label="Besoin d'aide ?"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <IconClose /> : <IconChat />}
        </button>
        {open && (
          <div className="help-panel" role="dialog" aria-label="Besoin d'aide ?">
            <h3 className="help-title">Besoin d'aide ?</h3>
            <p className="help-lead">Une question, un souci ? Choisissez le moyen qui vous convient.</p>
            <button type="button" className="help-item primary" onClick={openContact}>
              <IconMail /><span>Nous écrire</span>
            </button>
            <Link to="/reclamation" className="help-item" onClick={close}>
              <IconAlert /><span>Problème sur une réservation</span>
            </Link>
            <a href="tel:+33766211483" className="help-item" onClick={close}>
              <IconPhone /><span>07 66 21 14 83</span>
            </a>
            <a href="mailto:contact@cazalia.fr" className="help-item" onClick={close}>
              <IconAt /><span>contact@cazalia.fr</span>
            </a>
          </div>
        )}
      </div>
      {contact && <ContactModal onClose={() => { setContact(false); btnRef.current?.focus(); }} />}
    </>
  );
}
