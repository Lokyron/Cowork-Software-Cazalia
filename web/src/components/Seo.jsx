import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { PAGES, SITE_NAME, canonicalUrl, baseUrl, findPage, ogImageUrl } from '../lib/seo.js';

// Met à jour <head> lors de la navigation côté client (le HTML servi aux
// crawlers, lui, est pré-généré au build par web/seo/plugin.js).
//
// Choix d'intégration : UN seul <RouteSeo /> posé dans App.jsx, qui résout la
// route courante via useLocation et la table PAGES. C'est la solution la moins
// invasive : aucune des pages (dont Pricing et Booking) n'est modifiée.
// Les cas particuliers (ex. NotFound) rendent <Seo ... /> avec leurs propres
// valeurs ; comme <RouteSeo /> est placé AVANT <Routes>, son effet s'exécute
// en premier et celui de la page, ensuite, a le dernier mot.

const DEFAULT = PAGES[0];

// Pose (ou crée) une balise <meta>/<link> du <head>, ou la retire si value est vide.
function setTag(tag, attr, key, valueAttr, value) {
  let el = document.head.querySelector(`${tag}[${attr}="${key}"]`);
  if (!value) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement(tag);
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute(valueAttr, value);
}

export default function Seo({ title, description, path, noindex = false }) {
  useEffect(() => {
    const base = baseUrl();
    const url = path ? canonicalUrl(path, base) : '';
    document.title = title;
    setTag('meta', 'name', 'description', 'content', description);
    setTag('link', 'rel', 'canonical', 'href', url);
    setTag('meta', 'property', 'og:title', 'content', title);
    setTag('meta', 'property', 'og:description', 'content', description);
    setTag('meta', 'property', 'og:url', 'content', url);
    setTag('meta', 'property', 'og:image', 'content', ogImageUrl(base));
    setTag('meta', 'name', 'robots', 'content', noindex ? 'noindex' : '');
  }, [title, description, path, noindex]);
  return null;
}

// Résout la route courante. Hors table PAGES (pages privées, 404) : titre
// neutre, pas de canonical.
export function RouteSeo() {
  const { pathname } = useLocation();
  const page = findPage(pathname);
  if (page) return <Seo title={page.title} description={page.description} path={page.path} />;
  return <Seo title={SITE_NAME} description={DEFAULT.description} />;
}
