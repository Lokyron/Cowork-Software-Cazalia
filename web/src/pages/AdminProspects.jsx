import { useEffect, useState, useCallback, useMemo } from 'react';
import { api, msg } from '../api.js';

const STATUSES = [
  ['nouveau', 'Nouveau'],
  ['contacte', 'Contacté'],
  ['journee_offerte', 'Journée offerte'],
  ['converti', 'Converti'],
  ['pas_interesse', 'Pas intéressé'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const STATUS_STYLE = {
  nouveau: { background: 'rgba(64,86,106,.12)', color: '#40566a' },
  contacte: { background: 'rgba(184,95,62,.16)', color: '#b85f3e' },
  journee_offerte: { background: 'rgba(142,167,155,.22)', color: '#4f6561' },
  converti: { background: '#648077', color: '#fff' },
  pas_interesse: { background: 'rgba(34,33,35,.10)', color: '#8092a0' },
};
const ACTIVITY_LABEL = {
  independant: 'Indépendant·e',
  salarie_teletravail: 'Télétravail',
  etudiant: 'Étudiant·e',
  entreprise: 'Entreprise',
  autre: 'Autre',
};

const norm = (s) => (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtDate = (iso) => {
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
};

function StatusBadge({ status }) {
  return (
    <span className="badge" style={{ ...STATUS_STYLE[status], fontWeight: 600 }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export default function AdminProspects() {
  const [prospects, setProspects] = useState([]);
  const [counts, setCounts] = useState({ total: 0 });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    const r = await api.get('/admin/prospects');
    setProspects(r.prospects);
    setCounts(r.counts);
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    return prospects.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (!q) return true;
      return norm(`${p.first_name} ${p.last_name} ${p.email} ${p.phone}`).includes(q);
    });
  }, [prospects, query, statusFilter]);

  const open = prospects.find((p) => p.id === openId) || null;

  return (
    <div>
      <div className="flex-between">
        <h1>Prospects</h1>
        <a className="qa" href="/api/admin/prospects/export.csv">⬇ Exporter en CSV</a>
      </div>
      <p className="subtitle">
        Les personnes qui se sont pré-inscrites via la page <code>/rejoindre</code>. Cliquez sur une ligne
        pour changer son statut, ajouter une note ou la supprimer.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="dash-kpis">
          <div className="kpi"><span className="kpi-l">Contacts</span><span className="kpi-v">{counts.total || 0}</span></div>
          <div className="kpi"><span className="kpi-l">Nouveaux</span><span className="kpi-v" style={{ color: '#40566a' }}>{counts.nouveau || 0}</span></div>
          <div className="kpi"><span className="kpi-l">Journée offerte</span><span className="kpi-v">{counts.journee_offerte || 0}</span></div>
          <div className="kpi"><span className="kpi-l">Convertis</span><span className="kpi-v" style={{ color: '#648077' }}>{counts.converti || 0}</span></div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, padding: 14 }}>
        <div className="row">
          <div className="field" style={{ flex: 2 }}>
            <input
              type="search"
              placeholder="🔍 Rechercher par nom, e-mail ou téléphone…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="field">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Tous les statuts</option>
              {STATUSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contact</th><th>Téléphone</th><th>Activité</th><th>Statut</th>
                <th style={{ textAlign: 'right' }}>Reçu le</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="row-clickable" onClick={() => setOpenId(p.id)}>
                  <td>
                    <strong>{p.first_name} {p.last_name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{p.email}</div>
                  </td>
                  <td className="muted">{p.phone}</td>
                  <td className="muted">{ACTIVITY_LABEL[p.activity] || '—'}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="muted" style={{ textAlign: 'right' }}>{fmtDate(p.created_at)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="muted">
                  {prospects.length === 0
                    ? 'Aucune pré-inscription pour l’instant. Partagez le lien /rejoindre pour commencer à collecter des contacts.'
                    : 'Aucun contact ne correspond à ce filtre.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && (
        <ProspectDetail
          prospect={open}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onDeleted={() => { setOpenId(null); load(); }}
        />
      )}
    </div>
  );
}

function ProspectDetail({ prospect, onClose, onChanged, onDeleted }) {
  const [status, setStatus] = useState(prospect.status);
  const [note, setNote] = useState(prospect.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const changeStatus = async (next) => {
    setStatus(next);
    setError(null);
    try {
      await api.patch(`/admin/prospects/${prospect.id}`, { status: next });
      onChanged();
    } catch (err) {
      setError(msg(err.code));
    }
  };

  const saveNote = async () => {
    setBusy(true); setError(null); setFlash(null);
    try {
      await api.patch(`/admin/prospects/${prospect.id}`, { note });
      setFlash('Note enregistrée.');
      onChanged();
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await api.del(`/admin/prospects/${prospect.id}`);
      onDeleted();
    } catch (err) {
      setError(msg(err.code));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{prospect.first_name} {prospect.last_name}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        <table style={{ marginBottom: 14 }}>
          <tbody>
            <tr><td className="muted">E-mail</td><td style={{ textAlign: 'right' }}><a href={`mailto:${prospect.email}`}>{prospect.email}</a></td></tr>
            <tr><td className="muted">Téléphone</td><td style={{ textAlign: 'right' }}><a href={`tel:${prospect.phone}`}>{prospect.phone}</a></td></tr>
            <tr><td className="muted">Activité</td><td style={{ textAlign: 'right' }}>{ACTIVITY_LABEL[prospect.activity] || '—'}</td></tr>
            <tr><td className="muted">Reçu le</td><td style={{ textAlign: 'right' }}>{fmtDate(prospect.created_at)}</td></tr>
            {prospect.source && <tr><td className="muted">Provenance</td><td style={{ textAlign: 'right' }}>{prospect.source}</td></tr>}
          </tbody>
        </table>

        <div className="field">
          <label>Statut du suivi</label>
          <select value={status} onChange={(e) => changeStatus(e.target.value)}>
            {STATUSES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Note interne</label>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : à rappeler après le 15, intéressé par une salle privative…" />
        </div>

        {error && <div className="alert error">{error}</div>}
        {flash && <div className="alert ok">{flash}</div>}

        <div className="flex-between" style={{ marginTop: 6 }}>
          {confirmDel ? (
            <button className="danger small" disabled={busy} onClick={remove}>
              {busy ? '…' : 'Confirmer la suppression'}
            </button>
          ) : (
            <button className="outline small" onClick={() => setConfirmDel(true)}>Supprimer</button>
          )}
          <button disabled={busy} onClick={saveNote}>{busy ? '…' : 'Enregistrer la note'}</button>
        </div>
      </div>
    </div>
  );
}
