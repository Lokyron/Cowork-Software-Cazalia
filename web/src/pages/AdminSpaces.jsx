import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const EMPTY = { name: '', kind: 'zone', capacity: 8, exclusive: false, privatizable: false, credits_per_hour: 2, color: '#1C3155', description: '', amenities: '', active: true };

export default function AdminSpaces() {
  const [spaces, setSpaces] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    const r = await api.get('/admin/spaces');
    setSpaces(r.spaces);
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({ name: s.name, kind: s.kind, capacity: s.capacity, exclusive: !!s.exclusive, privatizable: !!s.privatizable, credits_per_hour: s.credits_per_hour, color: s.color, description: s.description || '', amenities: s.amenities || '', active: !!s.active });
  };
  const reset = () => { setEditingId(null); setForm(EMPTY); };

  const submit = async (e) => {
    e.preventDefault();
    setFeedback(null);
    const payload = {
      ...form,
      capacity: Number(form.capacity),
      credits_per_hour: Number(form.credits_per_hour),
    };
    try {
      if (editingId) await api.put(`/admin/spaces/${editingId}`, payload);
      else await api.post('/admin/spaces', payload);
      reset();
      load();
      setFeedback({ type: 'ok', text: 'Espace enregistré.' });
    } catch {
      setFeedback({ type: 'error', text: 'Échec de l\'enregistrement.' });
    }
  };

  return (
    <div>
      <h1>Espaces</h1>
      <p className="subtitle">Espaces d'inventaire (tarif par place) ou salle exclusive (forfait). Option de privatisation pour les salles focus.</p>
      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}

      <div className="grid cols-2">
        <div className="card">
          <h2>{editingId ? 'Modifier l\'espace' : 'Nouvel espace'}</h2>
          <form onSubmit={submit}>
            <div className="field">
              <label>Nom</label>
              <input value={form.name} onChange={set('name')} required />
            </div>
            <div className="row">
              <div className="field">
                <label>Type</label>
                <select value={form.kind} onChange={set('kind')}>
                  <option value="zone">Zone (open-space)</option>
                  <option value="room">Salle</option>
                </select>
              </div>
              <div className="field">
                <label>{form.exclusive ? 'Occupants max' : 'Capacité (places)'}</label>
                <input type="number" min="1" value={form.capacity} onChange={set('capacity')} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.exclusive} onChange={set('exclusive')} />
                Réservation exclusive (bloque toute la salle, tarif forfait)
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: form.exclusive ? 0.5 : 1 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.privatizable} disabled={form.exclusive} onChange={set('privatizable')} />
                Option privatisation (prendre toutes les places)
              </label>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <div className="field">
                <label>{form.exclusive ? 'Crédits/h (forfait salle)' : 'Crédits/h (par place)'}</label>
                <input type="number" min="0" value={form.credits_per_hour} onChange={set('credits_per_hour')} />
              </div>
              <div className="field" style={{ maxWidth: 90 }}>
                <label>Couleur</label>
                <input type="color" value={form.color} onChange={set('color')} style={{ height: 42, padding: 4 }} />
              </div>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Description (affichée sur la landing)</label>
              <textarea rows={3} value={form.description} onChange={set('description')} placeholder="Descriptif de l'espace…" />
            </div>
            <div className="field">
              <label>Prestations incluses (une par ligne)</label>
              <textarea rows={5} value={form.amenities} onChange={set('amenities')} placeholder={'Wi-Fi fibre\nCafé à volonté\n…'} />
            </div>
            <label style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={set('active')} />
              Actif (réservable)
            </label>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button type="submit">{editingId ? 'Enregistrer' : 'Créer'}</button>
              {editingId && <button type="button" className="outline" onClick={reset}>Annuler</button>}
            </div>
          </form>
        </div>

        <div className="card">
          <h2>Espaces existants</h2>
          <table>
            <thead><tr><th>Nom</th><th>Type</th><th>Cap.</th><th>Cr/h</th><th></th></tr></thead>
            <tbody>
              {spaces.map((s) => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                  <td><span className="dot" style={{ background: s.color }} />{s.name}</td>
                  <td>{s.exclusive ? 'Exclusive' : s.privatizable ? 'Focus' : 'Open-space'}</td>
                  <td>{s.capacity}</td>
                  <td>{s.credits_per_hour}</td>
                  <td><button className="outline small" onClick={() => startEdit(s)}>Éditer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
