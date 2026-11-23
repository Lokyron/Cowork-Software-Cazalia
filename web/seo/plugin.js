import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import {
  DEFAULT_BASE_URL, PAGES, PRIVATE_PATHS, canonicalUrl, baseUrl, ogImageUrl,
} from '../src/lib/seo.js';

// Plugin Vite : après l'écriture du bundle, génère dans dist/ robots.txt,
// sitemap.xml et un index.html par route indexable (même application, balises
// <head> propres à la route) pour que crawlers et aperçus de lien voient les
// bonnes métadonnées sans exécuter de JavaScript.
//
// GARANTIE : ce plugin ne fait jamais échouer le build. Toute erreur est
// attrapée et signalée par un avertissement ; le déploiement continue.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Remplace une balise existante du HTML ; échoue bruyamment si elle est absente
// (on préfère un avertissement à des métadonnées silencieusement fausses).
function replaceTag(html, re, replacement, label) {
  if (!re.test(html)) throw new Error(`balise « ${label} » introuvable dans index.html`);
  return html.replace(re, () => replacement);
}

function renderPage(html, page, base) {
  const url = canonicalUrl(page.path, base);
  const t = esc(page.title);
  const d = esc(page.description);
  let out = html;
  out = replaceTag(out, /<title>[\s\S]*?<\/title>/, `<title>${t}</title>`, 'title');
  out = replaceTag(out, /<meta\s+name="description"[^>]*>/, `<meta name="description" content="${d}" />`, 'description');
  out = replaceTag(out, /<link\s+rel="canonical"[^>]*>/, `<link rel="canonical" href="${esc(url)}" />`, 'canonical');
  out = replaceTag(out, /<meta\s+property="og:title"[^>]*>/, `<meta property="og:title" content="${t}" />`, 'og:title');
  out = replaceTag(out, /<meta\s+property="og:description"[^>]*>/, `<meta property="og:description" content="${d}" />`, 'og:description');
  out = replaceTag(out, /<meta\s+property="og:url"[^>]*>/, `<meta property="og:url" content="${esc(url)}" />`, 'og:url');
  out = replaceTag(out, /<meta\s+property="og:image"[^>]*>/, `<meta property="og:image" content="${esc(ogImageUrl(base))}" />`, 'og:image');
  // index.html écrit le domaine par défaut en dur (JSON-LD, et les balises
  // canonical/og:* déjà remplacées ci-dessus) ; twitter:card retombe sur og:image.
  // Si la base est surchargée, on aligne le reste (JSON-LD) sur la nouvelle base.
  if (base !== DEFAULT_BASE_URL) out = out.split(DEFAULT_BASE_URL).join(base);
  return out;
}

export default function seoPlugin() {
  let config;
  let env = {};
  return {
    name: 'cazalia-seo',
    apply: 'build',
    configResolved(c) {
      config = c;
      try { env = loadEnv(c.mode, c.envDir || c.root, 'VITE_'); } catch { env = {}; }
    },
    closeBundle() {
      try {
        const dist = join(config.root, config.build.outDir);
        const base = baseUrl(env.VITE_PUBLIC_BASE_URL || process.env.VITE_PUBLIC_BASE_URL);
        const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');

        // Pages : '/' réécrit sur place, les autres dans dist/<route>/index.html.
        const indexable = PAGES.filter((p) => p.indexable);
        for (const page of indexable) {
          const html = renderPage(indexHtml, page, base);
          if (page.path === '/') {
            writeFileSync(join(dist, 'index.html'), html);
          } else {
            const dir = join(dist, page.path);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'index.html'), html);
          }
        }

        const robots = [
          'User-agent: *',
          'Allow: /',
          ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
          '',
          `Sitemap: ${base}/sitemap.xml`,
          '',
        ].join('\n');
        writeFileSync(join(dist, 'robots.txt'), robots);

        const lastmod = new Date().toISOString().slice(0, 10);
        const urls = indexable
          .map((p) => `  <url>\n    <loc>${esc(canonicalUrl(p.path, base))}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
          .join('\n');
        writeFileSync(
          join(dist, 'sitemap.xml'),
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
        );
      } catch (err) {
        // Jamais bloquant : le SEO ne doit pas empêcher un déploiement.
        console.warn(`\n[cazalia-seo] AVERTISSEMENT : génération SEO incomplète, le build continue. Cause : ${err?.message || err}\n`);
      }
    },
  };
}
