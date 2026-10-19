// Réduction d'une photo DANS LE NAVIGATEUR avant son envoi.
//
// Une photo de téléphone pèse 5 à 10 Mo pour 4000 px de large : telle quelle,
// elle alourdirait la page d'accueil de plusieurs dizaines de méga-octets pour
// un affichage qui n'en utilise qu'une fraction. On redimensionne donc côté
// client, ce qui évite aussi d'ajouter une dépendance native (sharp) au serveur
// et de lui faire porter le décodage d'images fournies de l'extérieur.

const MAX_SIDE = 2000;   // largeur/hauteur maximale conservée
const QUALITY = 0.82;    // compromis qualité/poids usuel pour du JPEG photo

/**
 * Charge un fichier image en bitmap décodé.
 * `createImageBitmap` est présent sur tous les navigateurs visés ; en cas
 * d'absence, on retombe sur un <img> et une URL d'objet.
 *
 * @param {File | Blob} file
 * @returns {Promise<{width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, close: () => void}>}
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file);
    return {
      width: bmp.width, height: bmp.height,
      draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
      close: () => bmp.close?.(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('IMAGE_ILLISIBLE'));
      el.src = url;
    });
    return {
      width: img.naturalWidth, height: img.naturalHeight,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Réduit et recompresse une photo.
 *
 * Le format de sortie est le JPEG, sauf pour un PNG déjà léger (logo, capture à
 * fond transparent) que l'on laisse intact : le convertir en JPEG lui ferait
 * perdre sa transparence et un fond noir apparaîtrait.
 *
 * @param {File} file Fichier choisi par l'utilisateur.
 * @returns {Promise<{blob: Blob, name: string}>} Image prête à envoyer.
 * @throws {Error} `FORMAT_NON_SUPPORTE` si le fichier n'est pas une image gérée.
 */
export async function prepareImage(file) {
  const type = String(file.type || '').toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) {
    const err = new Error('FORMAT_NON_SUPPORTE');
    err.code = 'FORMAT_NON_SUPPORTE';
    throw err;
  }
  // PNG léger : on n'y touche pas (transparence préservée).
  if (type === 'image/png' && file.size <= 400 * 1024) return { blob: file, name: file.name };

  const src = await decode(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));

    // Déjà aux bonnes dimensions ET raisonnablement légère : inutile de
    // recompresser, ce qui ne ferait que dégrader l'image.
    if (scale === 1 && file.size <= 600 * 1024) return { blob: file, name: file.name };

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    src.draw(ctx, w, h);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('ENCODAGE_ECHOUE'))), 'image/jpeg', QUALITY);
    });
    // Si la « réduction » a grossi le fichier (petite image très compressée au
    // départ), on garde l'original.
    if (blob.size >= file.size && scale === 1) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } finally {
    src.close();
  }
}

/**
 * Taille lisible par un humain, pour l'interface.
 * @param {number} bytes
 * @returns {string}
 */
export function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${Math.round(bytes / 1024)} Ko`;
}
