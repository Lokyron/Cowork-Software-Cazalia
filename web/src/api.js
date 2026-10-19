// Petit client fetch. Cookie de session envoyé automatiquement (same-origin / proxy).
async function request(method, url, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: {},
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse sans corps */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP_${res.status}`);
    err.code = data && data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Envoi d'un fichier binaire (photo). Le corps est le fichier BRUT, sans
 * multipart : l'API le reçoit tel quel et en déduit le format par sa signature.
 *
 * @param {string} url Chemin relatif à `/api`.
 * @param {Blob} blob Contenu de l'image (déjà réduite par `lib/image.js`).
 * @param {string} name Nom d'origine, repris pour nommer le fichier stocké.
 * @returns {Promise<object>}
 */
async function upload(url, blob, name) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`/api${url}${sep}name=${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  });
  let data = null;
  try { data = await res.json(); } catch { /* réponse sans corps */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP_${res.status}`);
    err.code = data && data.error;
    err.status = res.status;
    // 413 : le corps a été coupé par Express avant d'arriver à la route, il n'y
    // a donc pas de code applicatif à afficher.
    if (res.status === 413) err.code = 'FICHIER_TROP_LOURD';
    throw err;
  }
  return data;
}

export const api = {
  upload,
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
};

// Messages d'erreur FR à partir des codes renvoyés par l'API (brief §8).
const MESSAGES = {
  COMPLET: 'Ce créneau est complet.',
  CREDITS_INSUFFISANTS: 'Crédits insuffisants pour cette réservation.',
  CRENEAU_INVALIDE: 'Créneau invalide (fin avant début).',
  CRENEAU_PASSE: 'Ce créneau est déjà passé.',
  DATE_INVALIDE: 'Date invalide.',
  IDENTIFIANTS_INVALIDES: 'Email ou mot de passe incorrect.',
  EMAIL_DEJA_PRIS: 'Cet email est déjà utilisé.',
  CHAMPS_INVALIDES: 'Champs manquants ou invalides.',
  TROP_DE_TENTATIVES: 'Trop de tentatives. Réessayez plus tard.',
  NON_AUTHENTIFIE: 'Veuillez vous connecter.',
  INTERDIT: 'Action non autorisée.',
  MONTANT_INVALIDE: 'Montant invalide.',
  DEJA_ANNULEE: 'Réservation déjà annulée.',
  MOT_DE_PASSE_FAIBLE:
    'Mot de passe trop faible : au moins 10 caractères, avec 3 types parmi minuscule, ' +
    'majuscule, chiffre et caractère spécial.',
  MOT_DE_PASSE_INVALIDE: 'Mot de passe invalide (longueur non acceptée).',
  MOT_DE_PASSE_ACTUEL_INVALIDE: 'Mot de passe actuel incorrect.',
  UTILISATEUR_INTROUVABLE: 'Utilisateur introuvable.',
  TOKEN_INVALIDE: 'Lien invalide ou expiré.',
  CONFIRMATION_INVALIDE: 'Veuillez taper SUPPRIMER pour confirmer.',
  DERNIER_ADMIN: 'Impossible de supprimer le dernier administrateur.',
  CODE_2FA_INVALIDE: 'Code de vérification incorrect.',
  SETUP_2FA_REQUIS: 'Configuration de la 2FA requise.',
  HORS_HORAIRES: "Ce créneau est hors des horaires d'ouverture.",
  TROP_DE_CRENEAUX: 'Trop de créneaux sélectionnés en une seule fois.',
  PANIER_PLEIN: 'Votre panier contient déjà trop de lignes.',
  PERIODE_INVALIDE: 'Période invalide (dates incorrectes ou intervalle trop large).',
  ORIGINE_INTERDITE: 'Requête bloquée pour raison de sécurité. Rechargez la page.',
  ROUTE_INTROUVABLE: 'Ressource introuvable.',
  AUCUN_DESTINATAIRE: 'Aucun destinataire sélectionné.',
  CONTENU_REQUIS: 'Choisissez un template ou saisissez un sujet et un corps.',
  TEMPLATE_INTROUVABLE: 'Template introuvable.',
  SMTP_NON_CONFIGURE: 'SMTP non configuré.',
  BREVO_NON_CONFIGURE: "Brevo non configuré : renseignez la clé d'API et l'adresse d'expédition.",
  CONNEXION_ECHOUEE: 'Connexion au fournisseur impossible (identifiants ou réseau).',
  ENVOI_ECHOUE: "L'envoi a été refusé par le fournisseur.",
  QUOTA_JOURNALIER_ATTEINT: "Plafond d'envois du jour atteint.",
  QUOTA_RESERVE_TRANSACTIONNEL: "Plafond commercial atteint : la fin du quota est réservée aux e-mails de réservation et de mot de passe.",
  URL_NON_PUBLIQUE: "L'adresse publique du site n'est pas joignable depuis Internet : déclarez l'URL à la main dans Brevo.",
  DECLARATION_ECHOUEE: "Brevo a refusé la déclaration automatique : recopiez l'URL à la main.",
  OPT_OUT: 'Le membre a refusé les communications.',
  FORMAT_NON_SUPPORTE: 'Format non reconnu : utilisez une photo JPEG, PNG ou WebP.',
  FICHIER_TROP_LOURD: 'Photo trop lourde, même après réduction.',
  FICHIER_INTROUVABLE: 'Photo introuvable.',
  EMPLACEMENT_INCONNU: 'Emplacement inconnu.',
  CORPS_VIDE: 'Aucune donnée reçue.',
  DOSSIER_NON_INSCRIPTIBLE: "Le dossier des photos n'est pas accessible en écriture sur le serveur : vérifiez le volume monté et son propriétaire.",
  EMAIL_INVALIDE: 'Adresse e-mail invalide.',
  TELEPHONE_INVALIDE: 'Numéro de téléphone invalide.',
  CONSENTEMENT_REQUIS: 'Merci de cocher la case de consentement.',
  STATUT_INVALIDE: 'Statut invalide.',
  PROSPECT_INTROUVABLE: 'Contact introuvable.',
  TROP_DE_TENTATIVES: 'Trop de tentatives. Réessayez dans quelques minutes.',
};
export function msg(code) {
  return MESSAGES[code] || 'Une erreur est survenue.';
}
