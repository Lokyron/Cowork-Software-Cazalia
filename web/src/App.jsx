import { useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Background from './components/Background.jsx';
import TwoFactorBanner from './components/TwoFactorBanner.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Rejoindre from './pages/Rejoindre.jsx';
import Cgu from './pages/Cgu.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import ForcePasswordChange from './pages/ForcePasswordChange.jsx';
import Booking from './pages/Booking.jsx';
import MemberDashboard from './pages/MemberDashboard.jsx';
import AccountSettings from './pages/AccountSettings.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import MemberPlanning from './pages/MemberPlanning.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AdminSpaces from './pages/AdminSpaces.jsx';
import AdminMembers from './pages/AdminMembers.jsx';
import AdminPlanning from './pages/AdminPlanning.jsx';
import AdminProspects from './pages/AdminProspects.jsx';
import AdminEmails from './pages/AdminEmails.jsx';
import AdminUpdate from './pages/AdminUpdate.jsx';

// Barre de navigation de l'application (utilisateur connecté).
function Nav() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const close = () => setOpen(false);
  const onLogout = async () => {
    close();
    await logout();
    navigate('/');
  };
  return (
    <header className="nav">
      <Link to="/" className="brand" onClick={close}>
        <img src="/images/logo-lockup-white.svg" className="brand-lockup" alt="Cazalia" />
      </Link>
      <button className="nav-back" onClick={() => { close(); navigate(-1); }} title="Revenir à la page précédente">
        ← <span className="nav-back-label">Retour</span>
      </button>
      <button
        className="nav-burger"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '✕' : '☰'}
      </button>
      <div className={`nav-collapse ${open ? 'open' : ''}`}>
        <nav onClick={close}>
          <NavLink to="/mon-espace">Mon espace</NavLink>
          {user.role !== 'admin' && (
            <>
              <NavLink to="/reserver">Réserver</NavLink>
              <NavLink to="/mon-planning">Mon planning</NavLink>
            </>
          )}
          <NavLink to="/mon-compte">Mon compte</NavLink>
          {user.role === 'admin' && (
            <>
              <span className="sep" />
              <NavLink to="/admin" end>Tableau de bord</NavLink>
              <NavLink to="/admin/planning">Planning</NavLink>
              <NavLink to="/admin/espaces">Espaces</NavLink>
              <NavLink to="/admin/membres">Membres</NavLink>
              <NavLink to="/admin/prospects">Prospects</NavLink>
              <NavLink to="/admin/emails">E-mails</NavLink>
              <NavLink to="/admin/maj">Mises à jour</NavLink>
            </>
          )}
        </nav>
        <div className="user">
          <span>{user.display_name}{user.role === 'admin' ? ' · admin' : ''}</span>
          <button className="ghost" onClick={onLogout}>Déconnexion</button>
        </div>
      </div>
    </header>
  );
}

function Guard({ children, admin }) {
  const { user } = useAuth();
  if (user === undefined) return <div className="center muted">Chargement…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/reserver" replace />;
  return children;
}

// Enveloppe les pages applicatives dans le conteneur centré.
const Shell = ({ children }) => <main className="container">{children}</main>;

// Pied de page global (présent sur toutes les pages hors landing, qui a le sien).
function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav className="footer-links">
        <Link to="/cgu">CGU &amp; mentions légales</Link>
        <Link to="/cgu#confidentialite">Confidentialité</Link>
      </nav>
      <span className="muted">© {new Date().getFullYear()} CAZALIA — Coworking Boutonnet</span>
    </footer>
  );
}

export default function App() {
  const { user } = useAuth();
  const location = useLocation();

  // La landing (/) et les pages publiques (/rejoindre, /cgu) ont leur propre
  // présentation ; on masque la nav applicative.
  const isLanding = location.pathname === '/';
  const isPublic = isLanding || ['/rejoindre', '/cgu'].includes(location.pathname);

  // Compte créé par l'admin : changement de mot de passe forcé avant tout accès.
  if (user && user.must_change_password) {
    return (
      <>
        <Background />
        <main className="container"><ForcePasswordChange /></main>
      </>
    );
  }

  return (
    <>
      <Background />
      {!isPublic && <Nav />}
      {!isPublic && user && !user.totp_enabled && <TwoFactorBanner />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/rejoindre" element={<Shell><Rejoindre /></Shell>} />
        <Route path="/cgu" element={<Shell><Cgu /></Shell>} />
        <Route path="/login" element={user ? <Navigate to="/mon-espace" replace /> : <Shell><Login /></Shell>} />
        <Route path="/reset-password" element={<Shell><ResetPassword /></Shell>} />
        <Route path="/mot-de-passe-oublie" element={<Shell><ForgotPassword /></Shell>} />
        <Route path="/reserver" element={<Guard><Shell><Booking /></Shell></Guard>} />
        <Route path="/mon-espace" element={<Guard><Shell><MemberDashboard /></Shell></Guard>} />
        <Route path="/mon-planning" element={<Guard><Shell><MemberPlanning /></Shell></Guard>} />
        <Route path="/mon-compte" element={<Guard><Shell><AccountSettings /></Shell></Guard>} />
        <Route path="/admin" element={<Guard admin><Shell><AdminDashboard /></Shell></Guard>} />
        <Route path="/admin/planning" element={<Guard admin><Shell><AdminPlanning /></Shell></Guard>} />
        <Route path="/admin/espaces" element={<Guard admin><Shell><AdminSpaces /></Shell></Guard>} />
        <Route path="/admin/membres" element={<Guard admin><Shell><AdminMembers /></Shell></Guard>} />
        <Route path="/admin/prospects" element={<Guard admin><Shell><AdminProspects /></Shell></Guard>} />
        <Route path="/admin/emails" element={<Guard admin><Shell><AdminEmails /></Shell></Guard>} />
        <Route path="/admin/maj" element={<Guard admin><Shell><AdminUpdate /></Shell></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!isLanding && <SiteFooter />}
    </>
  );
}
