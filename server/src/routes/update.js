// Endpoints de version et de mise à jour (réservés à l'admin). Démarrer une mise
// à jour ne fait qu'écrire un fichier de requête ; le travail se fait hors de
// l'application, en root, dans le service updater (voir deploy/).
import { Router } from 'express';
import { requireAdmin } from '../middleware.js';
import {
  checkForUpdate, currentChannel, installedVersion, requestUpdate, setChannel, updateSettings, updateStatus,
} from '../update.js';

export const updateRouter = Router();
updateRouter.use(requireAdmin);

/** La photo complète : ce qui est installé, ce que le canal propose, où en est une MAJ. */
async function report({ force = false } = {}) {
  const payload = {
    ok: true,
    ...updateSettings(),
    installed: installedVersion(),
    status: updateStatus(),
    latest: null,
    error: null,
  };
  try {
    payload.latest = await checkForUpdate({ force, channel: currentChannel() });
  } catch (error) {
    payload.error = error.message;
  }
  return payload;
}

updateRouter.get('/', async (req, res) => {
  res.json(await report({ force: req.query.check === '1' }));
});

// Changer de canal regarde aussitôt ce que cette branche propose : tout l'intérêt
// du changement est de voir s'il y a quelque chose à tester.
updateRouter.post('/channel', async (req, res) => {
  try {
    setChannel(String(req.body?.channel || ''));
    res.json(await report({ force: true }));
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code ?? null });
  }
});

updateRouter.post('/start', (_req, res) => {
  try {
    const channel = requestUpdate();
    res.json({ ok: true, channel, status: updateStatus() });
  } catch (error) {
    // Pas 409 : le navigateur le prendrait pour « configuration requise » et quitterait la page.
    res.status(error.code === 'disabled' ? 503 : 400).json({ error: error.message, code: error.code ?? null });
  }
});
