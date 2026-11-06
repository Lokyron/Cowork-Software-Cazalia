import { useEffect, useState, useCallback, useRef } from 'react';
import { api, msg } from '../api.js';
import { prepareImage } from '../lib/image.js';

const EMPTY = { name: '', kind: 'zone', category: '', capacity: 8, exclusive: false, privatizable: false, price_per_hour: 7, price_half_day: '', price_day: '', color: '#1C3155', description: '', amenities: '', photo: null, active: true };
// Centimes (API) → chaîne euros pour l'édition ('' si forfait non défini).
const centsToEur = (c) => (c == null ? '' : String(c / 100));

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
    setForm({ name: s.name, kind: s.kind, category: s.category || '', capacity: s.capacity, exclusive: !!s.exclusive, privatizable: !!s.privatizable, price_per_hour: centsToEur(s.price_per_hour_cents), price_half_day: centsToEur(s.price_half_day_cents), price_day: centsToEur(s.price_day_cents), color: s.color, description: s.description || '', amenities: s.amenities || '', photo: s.photo || null, active: !!s.active });
  };
  const reset = () => { setEditingId(null); setForm(EMPTY); };

  const submit = async (e) => {
    e.preventDefault();
    setFeedback(null);
    const payload = {
      ...form,
      capacity: Number(form.capacity),
      // Euros (laissés tels quels) ; le serveur convertit en centimes. '' = forfait non proposé.
      price_per_hour: form.price_per_hour,
      price_half_day: form.price_half_day,
      price_day: form.price_day,
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
            <div className="field">
              <label>Catégorie <span className="muted" style={{ fontWeight: 400 }}>(tarification & réservabilité)</span></label>
              <select value={form.category} onChange={set('category')}>
                <option value="">- Non catégorisé (non réservable en ligne) -</option>
                <option value="OPEN_SPACE">Open Space (½-journée / journée)</option>
                <option value="MEETING_ROOM">Salle de réunion (heure / forfaits)</option>
                <option value="CONFIDENTIAL">Salle confidentielle (libre-service, non réservable)</option>
                <option value="PRIVATE_OFFICE">Bureau privé (sur devis, non réservable)</option>
              </select>
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
                <label>{form.exclusive ? 'Tarif horaire € (forfait salle)' : 'Tarif horaire € (par place)'}</label>
                <input type="number" min="0" step="0.01" value={form.price_per_hour} onChange={set('price_per_hour')} />
              </div>
              <div className="field" style={{ maxWidth: 90 }}>
                <label>Couleur</label>
                <input type="color" value={form.color} onChange={set('color')} style={{ height: 42, padding: 4 }} />
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>Forfait demi-journée € <span className="muted">(vide = non proposé)</span></label>
                <input type="number" min="0" step="0.01" placeholder="ex. 12" value={form.price_half_day} onChange={set('price_half_day')} />
              </div>
              <div className="field">
                <label>Forfait journée € <span className="muted">(vide = non proposé)</span></label>
                <input type="number" min="0" step="0.01" placeholder="ex. 20" value={form.price_day} onChange={set('price_day')} />
              </div>
            </div>
            <SpacePhotoField
              photo={form.photo}
              onChange={(photo) => setForm((f) => ({ ...f, photo }))}
              onError={(text) => setFeedback({ type: 'error', text })}
            />
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
            <thead><tr><th>Nom</th><th>Type</th><th>Cap.</th><th>€/h · ½j · j</th><th></th></tr></thead>
            <tbody>
              {spaces.map((s) => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                  <td><span className="dot" style={{ background: s.color }} />{s.name}</td>
                  <td>{s.exclusive ? 'Exclusive' : s.privatizable ? 'Focus' : 'Open-space'}</td>
                  <td>{s.capacity}</td>
                  <td className="muted seats">
                    {centsToEur(s.price_per_hour_cents) || '-'}€
                    {' · '}{s.price_half_day_cents != null ? `${s.price_half_day_cents / 100}€` : '-'}
                    {' · '}{s.price_day_cents != null ? `${s.price_day_cents / 100}€` : '-'}
                  </td>
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

/**
 * Champ « photo de l'espace » : aperçu, envoi (glisser-déposer ou sélection) et
 * retrait. La photo est réduite dans le navigateur, envoyée à la bibliothèque de
 * médias, et c'est son NOM DE FICHIER qui est enregistré avec l'espace - elle
 * n'est donc pas perdue à la prochaine mise à jour de l'application.
 */
function SpacePhotoField({ photo, onChange, onError }) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const send = async (file) => {
    if (!file || !file.type?.startsWith('image/')) return;
    setBusy(true);
    try {
      const { blob, name } = await prepareImage(file);
      const up = await api.upload('/admin/media', blob, name);
      // La photo n'est rattachée qu'à l'enregistrement du formulaire : on ne
      // modifie pas l'espace dans le dos de l'utilisateur.
      onChange(up.file);
    } catch (err) { onError(msg(err.code)); } finally { setBusy(false); }
  };

  return (
    <div className="field" style={{ marginTop: 14 }}>
      <label>Photo (affichée sur la landing)</label>
      <div className="space-photo-field">
        {photo && <img src={`/api/media/${encodeURIComponent(photo)}`} alt="" className="space-photo-preview" />}
        <div
          className={`dropzone compact ${over ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) send(e.dataTransfer.files?.[0]); }}
          onClick={() => !busy && input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
        >
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
            onChange={(e) => { send(e.target.files?.[0]); e.target.value = ''; }} />
          <span>{busy ? 'Envoi…' : (photo ? 'Remplacer la photo' : 'Glissez une photo ici, ou cliquez')}</span>
        </div>
      </div>
      {photo && (
        <button type="button" className="link-danger" style={{ marginTop: 6 }} onClick={() => onChange(null)}>
          Retirer la photo
        </button>
      )}
      <small className="muted">Enregistrée avec l'espace. Sans photo, celle livrée avec l'application est utilisée.</small>
    </div>
  );
}
