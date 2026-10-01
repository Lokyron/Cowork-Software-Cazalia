import { useState } from 'react';

// <img> avec fallback élégant tant que la vraie photo n'est pas fournie.
// Dépose les fichiers dans web/public/images/ (voir le README de ce dossier).
export default function Photo({ src, alt = '', className = '', caption }) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div className={`photo-ph ${className}`} role="img" aria-label={alt || caption}>
        <span>📷 {caption || 'Photo à venir'}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
