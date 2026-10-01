// Avatar « initiales + couleur » (pas d'upload de fichier pour l'instant).
// Couleur dérivée du nom de façon déterministe (même personne → même couleur).
const PALETTE = ['#1c3155', '#3b82f6', '#6366f1', '#0e7490', '#15803d', '#b45309', '#be123c', '#7c3aed'];

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export default function Avatar({ name, size = 44 }) {
  return (
    <span className="avatar" style={{
      width: size, height: size, background: colorFor(name),
      fontSize: Math.round(size * 0.4),
    }} aria-hidden="true">{initials(name)}</span>
  );
}
