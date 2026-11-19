import { useState } from 'react';

// <img> avec fallback élégant tant que la vraie photo n'est pas fournie.
// Dépose les fichiers dans web/public/images/ (voir le README de ce dossier).
//
// `frame` (`{zoom, posX, posY}`) : recadrage non destructif choisi dans
// l'administration. Absent = rendu d'origine, strictement inchangé. Présent,
// l'image est enveloppée dans un <figure> qui porte la classe de contexte
// (taille, arrondi, ombre) et clippe le zoom.
/** Style CSS d'un cadrage : même formule à l'écran public et dans l'éditeur. */
export function frameStyle(frame) {
  const { zoom, posX, posY } = frame;
  return {
    objectFit: 'cover',
    objectPosition: `${posX}% ${posY}%`,
    transform: `scale(${zoom})`,
    transformOrigin: `${posX}% ${posY}%`,
  };
}

export default function Photo({ src, alt = '', className = '', caption, frame }) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div className={`photo-ph ${className}`} role="img" aria-label={alt || caption}>
        <span>📷 {caption || 'Photo à venir'}</span>
      </div>
    );
  }
  if (frame) {
    return (
      <figure className={className}>
        <img
          src={src}
          alt={alt}
          className="photo-img"
          style={frameStyle(frame)}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </figure>
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
