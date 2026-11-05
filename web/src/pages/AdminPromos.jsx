import { useEffect, useState, useCallback } from 'react';
import { api, msg } from '../api.js';

const TARIFS = [
  ['', 'Toutes les formules'],
  ['journee', 'Formule Journée uniquement'],
  ['demi_journee', 'Formule Demi-journée uniquement'],
  ['heure', 'Formule Heure uniquement'],
];
const TARIF_LABEL = {
  journee: 'Journée', demi_journee: 'Demi-journée', heure: 'Heure', '': 'Toutes',
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtReduction = (p) =>
  p.reduction_type === 'percent' ? `-${p.reduction_value} %` : `-${(p.reduction_value / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`;

const EMPTY = { code: '', reduction_type: 'percent', reduction_value: '', tarif_restriction: 'journee', max_redemptions: '', expires_at: '' };

export default function AdminPromos() {
  const [promos, setPromos] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/promos');
      setPromos(r.promos || []);
    } catch (err) { setError(msg(err.code)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null);
    const value = Number(form.reduction_value);
    if (!Number.isFinite(value) || value <= 0) { setError('Indiquez une valeur de réduction valide.'); return; }
    if (form.reduction_type === 'percent' && value > 100) { setError('Un pourcentage ne peut pas dépasser 100.'); return; }
    setBusy(true);
    try {
      const payload = {
        code: form.code.trim() || null,
        reduction_type: form.reduction_type,
        // Montant fixe saisi en euros → centimes ; pourcentage tel quel.
        reduction_value: form.reduction_type === 'amount' ? Math.round(value * 100) : Math.round(value),
        tarif_restriction: form.tarif_restriction || null,
        max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : null,
        expires_at: form.expires_at ? `${form.expires_at}T23:59:59` : null,
      };
      const r = await api.post('/admin/promos', payload);
      setNotice(`Code « ${r.promo.code} » créé.`);
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(msg(err.code));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p) => {
    setError(null);
    try { await api.patch(`/admin/promos/${p.id}`, { active: !p.active }); load(); }
    catch (err) { setError(msg(err.code)); }
  };

  const remove = async (p) => {
    setError(null);
    if (!window.confirm(`Supprimer définitivement le code « ${p.code} » ? Il ne sera plus utilisable.`)) return;
    try { await api.del(`/admin/promos/${p.id}`); load(); }
    catch (err) { setError(msg(err.code)); }
  };

  return (
    <div>
      <div className="flex-between">
        <h1>Codes promo</h1>
      </div>
      <p className="subtitle">
        Codes de réduction appliqués au paiement (saisis par le client sur la page Stripe). Chaque code
        s'appuie sur un coupon Stripe&nbsp;: Stripe applique la remise et compte les utilisations.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Créer un code</h2>
        <form onSubmit={create}>
          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>Code <span className="muted" style={{ fontWeight: 400 }}>(vide = aléatoire)</span></label>
              <input value={form.code} onChange={set('code')} placeholder="BIENVENUE2026" maxLength={40} />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.reduction_type} onChange={set('reduction_type')}>
                <option value="percent">Pourcentage (%)</option>
                <option value="amount">Montant fixe (€)</option>
              </select>
            </div>
            <div className="field">
              <label>{form.reduction_type === 'percent' ? 'Réduction (%)' : 'Réduction (€)'}</label>
              <input
                type="number" min="1" step={form.reduction_type === 'percent' ? '1' : '0.01'}
                value={form.reduction_value} onChange={set('reduction_value')}
                placeholder={form.reduction_type === 'percent' ? '100' : '15'} required
              />
            </div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>Restriction de formule</label>
              <select value={form.tarif_restriction} onChange={set('tarif_restriction')}>
                {TARIFS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Nb max d'utilisations <span className="muted" style={{ fontWeight: 400 }}>(vide = illimité)</span></label>
              <input type="number" min="1" value={form.max_redemptions} onChange={set('max_redemptions')} placeholder="ex. 20" />
            </div>
            <div className="field">
              <label>Expire le <span className="muted" style={{ fontWeight: 400 }}>(facultatif)</span></label>
              <input type="date" value={form.expires_at} onChange={set('expires_at')} />
            </div>
          </div>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert ok">{notice}</div>}
          <button type="submit" disabled={busy}>{busy ? '…' : 'Créer le code'}</button>
        </form>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Codes existants</h2>
        {!promos.length ? (
          <p className="muted">Aucun code pour le moment.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Réduction</th><th>Formule</th><th>Utilisations</th><th>Expire</th><th>État</th><th></th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id}>
                  <td><code className="voucher-code" style={{ fontSize: 14, padding: '2px 8px' }}>{p.code}</code></td>
                  <td>{fmtReduction(p)}</td>
                  <td>{TARIF_LABEL[p.tarif_restriction || '']}</td>
                  <td>{p.times_redeemed != null ? p.times_redeemed : '—'}{p.max_redemptions ? ` / ${p.max_redemptions}` : ''}</td>
                  <td>{fmtDate(p.expires_at)}</td>
                  <td><span className={`badge ${p.active ? 'green' : 'grey'}`}>{p.active ? 'Actif' : 'Inactif'}</span></td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" className="ghost small" onClick={() => toggle(p)}>
                      {p.active ? 'Désactiver' : 'Activer'}
                    </button>
                    <button type="button" className="ghost small" style={{ color: 'var(--red)' }} onClick={() => remove(p)}>
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
