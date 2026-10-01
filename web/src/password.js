// Politique de mot de passe côté client.
//
// ⚠️ Ce contrôle est un CONFORT D'INTERFACE, pas une protection : il donne un
// retour immédiat au lieu d'un aller-retour serveur. La règle qui fait foi est
// celle de `server/src/lib/passwords.js` (`assertStrongPassword`), appliquée à
// chaque requête — un client modifié ne peut donc rien contourner.
// Les deux implémentations doivent rester alignées.

export const PASSWORD_MIN_LENGTH = 10;

export const PASSWORD_RULE =
  `Au moins ${PASSWORD_MIN_LENGTH} caractères, avec au minimum 3 types parmi : ` +
  'minuscule, majuscule, chiffre, caractère spécial.';

const COMMON = new Set([
  'password', 'motdepasse', 'azerty', 'azertyuiop', 'qwerty', 'qwertyuiop',
  'motdepasse', 'bonjour', 'coworking', 'cazalia', 'lucie', 'soleil',
  'admin', 'administrateur', 'welcome', 'bienvenue', 'iloveyou', 'abcdef',
]);

/**
 * Vérifie un mot de passe candidat.
 *
 * @param {string} pw Mot de passe saisi.
 * @returns {string | null} Message d'erreur à afficher, ou `null` si conforme.
 */
export function checkPassword(pw) {
  const value = String(pw ?? '');
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Le mot de passe doit faire au moins ${PASSWORD_MIN_LENGTH} caractères.`;
  }
  if (value.length > 200) return 'Le mot de passe est trop long (200 caractères maximum).';
  const familles =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value)) + Number(/[^A-Za-z0-9]/.test(value));
  if (familles < 3) {
    return 'Mélangez au moins 3 types de caractères : minuscule, majuscule, chiffre, caractère spécial.';
  }
  if (/^(.)\1+$/.test(value)) return 'Ce mot de passe est trop répétitif.';
  if (COMMON.has(value.toLowerCase().replace(/[^a-z]/g, ''))) {
    return 'Ce mot de passe est trop courant, choisissez-en un autre.';
  }
  return null;
}
