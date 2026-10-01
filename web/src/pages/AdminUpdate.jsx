import { useEffect, useState, useCallback, useRef } from 'react';
import { api, msg } from '../api.js';

const CHANNEL_LABEL = { stable: 'Stable', beta: 'Bêta' };
const CHANNEL_HINT = {
  stable: 'Version éprouvée, recommandée au quotidien.',
  beta: 'Pour tester les nouveautés avant leur passage en stable.',
};
const STEP_LABEL = {
  requested: 'Demande envoyée…',
  start: 'Démarrage…',
  download: 'Téléchargement de la nouvelle version…',
  version: 'Lecture de la version…',
  dependencies: 'Installation des dépendances…',
  build: 'Compilation de l’interface…',
  swap: 'Mise en place…',
  restart: 'Redémarrage du service…',
  complete: 'Terminé.',
};

const shortSha = (s) => (s ? String(s).slice(0, 7) : '—');
const fmt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function AdminUpdate() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);      // changement de canal / démarrage
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async ({ check = false } = {}) => {
    try {
      const d = await api.get(`/admin/update${check ? '?check=1' : ''}`);
      setData(d);
      setError(null);
      return d;
    } catch (e) {
      setError(msg(e));
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => { await load(); setLoading(false); })();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  // Suivi d'une mise à jour en cours : on interroge l'API jusqu'à done/failed/idle.
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const d = await load();
      const state = d?.status?.state;
      if (state !== 'running') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (state === 'done') setNotice('Mise à jour installée. L’interface a été rechargée.');
        if (state === 'failed') setError(`Échec : ${d?.status?.message || 'raison inconnue'}. La version précédente a été remise en place.`);
      }
    }, 3000);
  }, [load]);

  useEffect(() => {
    if (data?.status?.state === 'running' && !pollRef.current) startPolling();
  }, [data, startPolling]);

  const onCheck = async () => {
    setChecking(true);
    setNotice(null);
    await load({ check: true });
    setChecking(false);
  };

  const onChannel = async (channel) => {
    if (channel === data?.channel || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await api.post('/admin/update/channel', { channel });
      setData(d);
    } catch (e) {
      setError(msg(e));
    }
    setBusy(false);
  };

  const onStart = async () => {
    const label = CHANNEL_LABEL[data?.channel] || data?.channel;
    if (!window.confirm(
      `Installer la dernière version du canal « ${label} » ?\n\n`
      + 'Le service va redécoller le temps de la mise à jour (quelques dizaines de secondes). '
      + 'En cas de problème, la version précédente est automatiquement remise en place.',
    )) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/admin/update/start');
      await load();
      startPolling();
    } catch (e) {
      setError(msg(e));
    }
    setBusy(false);
  };

  if (loading) return <div className="center muted">Chargement…</div>;

  const running = data?.status?.state === 'running';
  const installed = data?.installed || {};
  const latest = data?.latest || null;
  const upToDate = latest && installed.commit && latest.commit
    && latest.commit.slice(0, 12) === installed.commit.slice(0, 12);
  const updateAvailable = latest && !upToDate;

  return (
    <div className="admin-update">
      <h1>Mises à jour</h1>
      <p className="muted">
        Installez les nouvelles versions de la plateforme directement d’ici. L’application ne
        modifie jamais son propre code&nbsp;: la mise à jour est exécutée par un service système dédié,
        avec retour automatique à la version précédente si la nouvelle ne démarre pas.
      </p>

      {!data?.enabled && (
        <div className="card" style={{ borderLeft: '4px solid #b85f3e' }}>
          <strong>Mises à jour in-app désactivées sur cette instance.</strong>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Activez-les en posant <code>UPDATE_ENABLED=1</code> dans l’environnement du service,
            et installez les unités <code>cowork-update.path</code> / <code>.service</code> (voir <code>deploy/</code>).
          </p>
        </div>
      )}

      {error && <div className="card" style={{ borderLeft: '4px solid #b85f3e' }}>{error}</div>}
      {notice && <div className="card" style={{ borderLeft: '4px solid #648077' }}>{notice}</div>}

      {/* Canal */}
      <div className="card">
        <h2>Canal</h2>
        <div className="channel-grid">
          {(data?.channels || []).map((c) => {
            const active = c.id === data?.channel;
            return (
              <button
                key={c.id}
                type="button"
                className={`channel-tile ${active ? 'active' : ''}`}
                onClick={() => onChannel(c.id)}
                disabled={busy || running}
              >
                <span className="channel-name">
                  {CHANNEL_LABEL[c.id] || c.id}
                  {active && <span className="badge green" style={{ marginLeft: 8 }}>actuel</span>}
                </span>
                <span className="muted">{CHANNEL_HINT[c.id] || `Branche ${c.branch}`}</span>
                <span className="muted" style={{ fontSize: 12 }}>branche&nbsp;: {c.branch}</span>
              </button>
            );
          })}
        </div>
        {(!data?.channels || data.channels.length < 2) && (
          <p className="muted" style={{ marginTop: 10 }}>
            Un seul canal est configuré. Définissez <code>UPDATE_BETA_BRANCH</code> côté service pour
            proposer un canal bêta.
          </p>
        )}
      </div>

      {/* Version installée vs disponible */}
      <div className="card">
        <h2>Version</h2>
        <dl className="kv">
          <dt>Installée</dt>
          <dd>
            v{installed.version || '?'} · <code>{shortSha(installed.commit)}</code>
            {installed.branch ? ` (${installed.branch})` : ''}
            <span className="muted"> — posée le {fmt(installed.installedAt)}</span>
          </dd>
          <dt>Dernière sur « {CHANNEL_LABEL[data?.channel] || data?.channel} »</dt>
          <dd>
            {latest ? (
              <>
                <code>{shortSha(latest.commit)}</code> — {latest.message || 'sans description'}
                <span className="muted"> ({fmt(latest.date)})</span>
              </>
            ) : <span className="muted">{data?.error || 'indisponible'}</span>}
          </dd>
        </dl>

        <div className="update-actions">
          <button className="outline" onClick={onCheck} disabled={checking || running}>
            {checking ? 'Vérification…' : 'Vérifier maintenant'}
          </button>
          <button
            className="primary"
            onClick={onStart}
            disabled={!data?.enabled || busy || running || !updateAvailable}
          >
            {running ? 'Mise à jour en cours…' : 'Mettre à jour maintenant'}
          </button>
        </div>

        {upToDate && !running && (
          <p className="muted" style={{ marginTop: 8 }}>✓ Vous êtes à jour sur ce canal.</p>
        )}
        {updateAvailable && !running && (
          <p className="muted" style={{ marginTop: 8 }}>Une nouvelle version est disponible.</p>
        )}
      </div>

      {/* État d'une mise à jour */}
      {data?.status && data.status.state !== 'idle' && (
        <div className="card">
          <h2>État</h2>
          {running && (
            <p>
              <span className="spinner" aria-hidden="true" />{' '}
              {STEP_LABEL[data.status.step] || data.status.step || 'En cours…'}
            </p>
          )}
          {data.status.state === 'done' && (
            <p>✓ {data.status.message || 'Mise à jour terminée.'}</p>
          )}
          {data.status.state === 'failed' && (
            <p style={{ color: '#b85f3e' }}>
              ✕ {data.status.message || 'La mise à jour a échoué.'} — la version précédente a été remise en place.
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Mis à jour {fmt(data.status.at)}
          </p>
        </div>
      )}
    </div>
  );
}
