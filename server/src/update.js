// Mise à jour « self-update », sans jamais donner à l'application le droit
// d'écrire son propre code.
//
// L'application se contente de déposer un fichier de requête dans son dossier de
// données. Une unité systemd « path » (root) surveille ce fichier et lance
// l'updater, qui télécharge la nouvelle version, build le front, l'installe et
// redémarre le service, puis écrit sa progression dans un fichier d'état que
// l'application relit. Voir deploy/ pour les unités et le script.
//
// Deux canaux sont proposés : « stable » (suit la branche principale) et
// « beta » (suit une branche pour tester un changement avant qu'il arrive en
// stable). Le fichier de requête porte un *nom de canal*, jamais un nom de
// branche : le mapping vit dans l'environnement du service root, donc le côté
// non privilégié ne peut pas pointer l'updater vers une ref arbitraire.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getSetting, setSetting } from './lib/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Racine de l'application installée (…/opt/lucie-cowork), d'où src = server/src.
const ROOT_DIR = path.resolve(__dirname, '..', '..');
// Dossier de données (écrivable par le service) = dossier de la base SQLite.
const DATA_DIR = path.dirname(config.dbPath);

const REQUEST_FILE = path.join(DATA_DIR, 'update.request');
const STATUS_FILE = path.join(DATA_DIR, 'update.status');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const META_CHANNEL = 'update.channel';

const { enabled: UPDATE_ENABLED, repo: UPDATE_REPO, branch: UPDATE_BRANCH,
  betaBranch: UPDATE_BETA_BRANCH, checkHours: UPDATE_CHECK_HOURS } = config.update;

const lastCheck = new Map(); // canal -> { at, commit, message, date }

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Les canaux offerts par cette instance, dans l'ordre d'affichage. */
export function channels() {
  const list = [{ id: 'stable', branch: UPDATE_BRANCH }];
  if (UPDATE_BETA_BRANCH && UPDATE_BETA_BRANCH !== UPDATE_BRANCH) {
    list.push({ id: 'beta', branch: UPDATE_BETA_BRANCH });
  }
  return list;
}

const isChannel = (name) => channels().some((channel) => channel.id === name);

/** Le canal en cours, repli sur stable si beta a été désactivé depuis. */
export function currentChannel() {
  const stored = getSetting(META_CHANNEL, null);
  return stored && isChannel(stored) ? stored : 'stable';
}

export function setChannel(name) {
  if (!isChannel(name)) {
    const error = new Error(`Canal de mise à jour inconnu « ${name} ».`);
    error.code = 'bad_channel';
    throw error;
  }
  setSetting(META_CHANNEL, name);
  return name;
}

export const branchOf = (channel) =>
  channels().find((entry) => entry.id === channel)?.branch ?? UPDATE_BRANCH;

/** Ce qui est installé : écrit par l'updater, ou inconnu sur une install manuelle. */
export function installedVersion() {
  const fromFile = readJson(VERSION_FILE);
  const pkg = readJson(path.join(ROOT_DIR, 'server', 'package.json'));
  return {
    version: pkg?.version ?? null,
    commit: fromFile?.commit ?? null,
    branch: fromFile?.branch ?? null,
    channel: fromFile?.channel ?? null,
    installedAt: fromFile?.installedAt ?? null,
  };
}

/** Demande à GitHub la tête de la branche d'un canal. Mise en cache par canal. */
export async function checkForUpdate({ force = false, channel = currentChannel() } = {}) {
  const branch = branchOf(channel);
  const known = lastCheck.get(channel);
  const maxAge = Math.max(1, UPDATE_CHECK_HOURS) * 3_600_000;
  if (!force && known && Date.now() - new Date(known.at).getTime() < maxAge) return known;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/commits/${encodeURIComponent(branch)}`,
      { signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cazalia' } },
    );
    // GitHub répond 422 pour une ref introuvable et 404 pour un dépôt invisible :
    // pour qui lit le panneau, les deux veulent dire la même chose.
    if (response.status === 404 || response.status === 422) {
      throw new Error(`Pas encore de branche « ${branch} » sur ${UPDATE_REPO}.`);
    }
    if (!response.ok) throw new Error(`GitHub a répondu ${response.status}`);
    const data = await response.json();
    const found = {
      at: new Date().toISOString(),
      channel,
      branch,
      commit: String(data.sha || '').slice(0, 40),
      message: String(data.commit?.message || '').split('\n')[0].slice(0, 120),
      date: data.commit?.committer?.date ?? null,
    };
    lastCheck.set(channel, found);
    return found;
  } finally {
    clearTimeout(timer);
  }
}

export function updateStatus() {
  const status = readJson(STATUS_FILE);
  return status && typeof status.state === 'string' ? status : { state: 'idle' };
}

/** Dépose le fichier de requête que l'updater surveille, en nommant le canal à installer. */
export function requestUpdate() {
  if (!UPDATE_ENABLED) {
    const error = new Error('Les mises à jour in-app sont désactivées sur cette instance.');
    error.code = 'disabled';
    throw error;
  }
  const running = updateStatus();
  if (running.state === 'running') {
    const error = new Error('Une mise à jour est déjà en cours.');
    error.code = 'busy';
    throw error;
  }
  const channel = currentChannel();
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'running', step: 'requested', channel, at: new Date().toISOString() }));
  fs.writeFileSync(REQUEST_FILE, `channel=${channel}\nat=${new Date().toISOString()}\n`);
  return channel;
}

export function updateSettings() {
  return {
    enabled: UPDATE_ENABLED,
    repo: UPDATE_REPO,
    channel: currentChannel(),
    channels: channels(),
    branch: branchOf(currentChannel()),
  };
}
