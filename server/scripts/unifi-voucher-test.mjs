// Test d'intégration autonome UniFi (UDM Pro) — valide l'authentification,
// la création puis la récupération et la suppression d'un voucher Wi-Fi.
//
// Prérequis (mode CLOUD, recommandé) : UNIFI_API_KEY + UNIFI_CONSOLE_ID (+ UNIFI_SITE).
// Mode LOCAL (alternative) : UNIFI_API_KEY + UNIFI_HOST.
// Ce test n'écrit rien dans la base applicative : lancez-le avec un DB_PATH jetable.
//
//   # Cloud (via api.ui.com)
//   UNIFI_API_KEY=xxxxx UNIFI_CONSOLE_ID=XXXX:NNNN UNIFI_SITE=default \
//   DB_PATH=/tmp/unifi-test.db node server/scripts/unifi-voucher-test.mjs
//
//   # Local (via l'IP du UDM)
//   UNIFI_API_KEY=xxxxx UNIFI_HOST=192.168.0.1 DB_PATH=/tmp/unifi-test.db \
//   node server/scripts/unifi-voucher-test.mjs
//
// Sortie standard : une ligne par étape (✓ / ✗). Code de sortie 0 si tout passe.

import { isConfigured, createVoucher, deleteVoucher } from '../src/lib/unifi.js';

const log = (ok, msg, extra) => console.log(`${ok ? '✓' : '✗'} ${msg}${extra ? '  ' + extra : ''}`);

async function main() {
  console.log('── Test intégration UniFi voucher ──');
  const mode = process.env.UNIFI_CONSOLE_ID ? `cloud (console ${process.env.UNIFI_CONSOLE_ID})` : `local (${process.env.UNIFI_HOST || '?'})`;
  console.log(`Mode : ${mode}  ·  Site : ${process.env.UNIFI_SITE || 'default'}`);

  if (!isConfigured()) {
    log(false, 'Configuration incomplète : définissez UNIFI_HOST et UNIFI_API_KEY.');
    process.exit(1);
  }

  let voucher;
  try {
    // Couvre en un appel : auth (X-API-KEY) + résolution du site + création + relecture du code.
    voucher = await createVoucher({ name: `TEST Cazalia ${new Date().toISOString()}` });
    log(true, 'Authentification + création voucher', `id=${voucher.id}`);
  } catch (err) {
    log(false, 'Création du voucher échouée', err.message);
    if (err.body) console.error('   Détail :', JSON.stringify(err.body));
    process.exit(1);
  }

  if (voucher.code) log(true, 'Récupération du code', `code=${voucher.code}`);
  else log(false, 'Code voucher absent de la réponse (à vérifier côté contrôleur)');

  try {
    await deleteVoucher(voucher.id);
    log(true, 'Suppression du voucher de test', `id=${voucher.id}`);
  } catch (err) {
    log(false, 'Suppression échouée (voucher de test à retirer manuellement)', err.message);
    process.exit(1);
  }

  console.log('── OK : intégration fonctionnelle ──');
  process.exit(0);
}

main().catch((err) => { console.error('Erreur inattendue :', err); process.exit(1); });
