import { useEffect, useRef, useState } from 'react';
import { api, msg } from '../api.js';
import { prepareImage } from '../lib/image.js';

// Écran « Photos » : les images de la page d'accueil sont modifiables ici, sans
// passer par le code ni par un accès au serveur. Les photos sont stockées dans
// un dossier persistant côté API (voir server/src/lib/media.js), elles survivent
// donc aux mises à jour de l'application.

function Section({ title, children, aside, hint }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="flex-between"><h2 style={{ margin: 0 }}>{title}</h2>{aside}</div>
      {hint && <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>{hint}</p>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

/**
 * Zone de dépôt : glisser-déposer ou clic pour choisir un ou plusieurs fichiers.
 * Les photos sont réduites dans le navigateur avant l'envoi.
 */
function DropZone({ onFiles, busy, multiple = true, label }) {
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const take = (fileList) => {
    const files = [...(fileList || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(multiple ? files : [files[0]]);
  };

  return (
    <div
      className={`dropzone ${over ? 'over' : ''} ${busy ? 'busy' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) take(e.dataTransfer.files); }}
      onClick={() => !busy && input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
    >
      <input
        ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple={multiple}
        style={{ display: 'none' }}
        onChange={(e) => { take(e.target.files); e.target.value = ''; }}
      />
      <span>{busy ? 'Envoi en cours…' : (label || 'Glissez vos photos ici, ou cliquez pour les choisir')}</span>
      <small className="muted">JPEG, PNG ou WebP · réduites automatiquement avant l'envoi</small>
    </div>
  );
}

export default function AdminPhotos() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [drag, setDrag] = useState({ from: null, over: null });

  const flash = (type, text) => { setFeedback({ type, text }); setTimeout(() => setFeedback(null), 5000); };
  const load = async () => setData(await api.get('/admin/media'));
  useEffect(() => { load().catch(() => {}); }, []);

  /** Réduit puis envoie une liste de fichiers vers un emplacement donné. */
  const send = async (files, slot) => {
    setBusy(true);
    try {
      for (const file of files) {
        const { blob, name } = await prepareImage(file);
        await api.upload(`/admin/media?slot=${slot}`, blob, name);
      }
      await load();
      flash('ok', files.length > 1 ? `${files.length} photos ajoutées.` : 'Photo ajoutée.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  const remove = async (file) => {
    setBusy(true);
    try {
      await api.del(`/admin/media/${encodeURIComponent(file)}`);
      await load();
      flash('ok', 'Photo supprimée.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  const clearSlot = async (slot) => {
    setBusy(true);
    try {
      await api.put('/admin/media/slot', { slot, file: null });
      await load();
      flash('ok', 'Photo retirée : la photo livrée avec l\'application reprend sa place.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  // ── Réordonnancement du carrousel (glisser-déposer natif) ─────────────────
  const dropAt = async (toIndex) => {
    const from = drag.from;
    setDrag({ from: null, over: null });
    if (from == null || from === toIndex) return;
    const order = data.carousel.map((p) => p.file);
    const [moved] = order.splice(from, 1);
    order.splice(toIndex, 0, moved);
    // Affichage optimiste : la vignette suit la souris sans attendre l'API.
    setData((c) => ({ ...c, carousel: order.map((f) => c.carousel.find((p) => p.file === f)) }));
    try {
      const r = await api.put('/admin/media/carousel', { order });
      setData((c) => ({ ...c, carousel: r.carousel }));
    } catch (err) { flash('error', msg(err.code)); await load(); }
  };

  const setSpacePhoto = async (spaceId, file) => {
    setBusy(true);
    try {
      await api.put(`/admin/spaces/${spaceId}`, { photo: file });
      await load();
      flash('ok', 'Photo de l\'espace mise à jour.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  if (!data) return <p className="muted">Chargement…</p>;

  return (
    <div>
      <h1>Photos</h1>
      <p className="subtitle">Les images de la page d'accueil, modifiables sans toucher au code.</p>
      {feedback && <div className={`alert ${feedback.type === 'ok' ? 'ok' : 'error'}`}>{feedback.text}</div>}
      {data.writable === false && (
        <div className="alert error">
          Le dossier des photos n'est pas accessible en écriture sur le serveur : les envois échoueront.
          Vérifiez le volume <code>/gallery</code> et son propriétaire (uid 1000).
        </div>
      )}

      {/* ── Carrousel ──────────────────────────────────────────────────────── */}
      <Section
        title="Carrousel de la page d'accueil"
        aside={<span className="badge grey">{data.carousel.length} photo{data.carousel.length > 1 ? 's' : ''}</span>}
        hint="Glissez les vignettes pour changer leur ordre d'apparition."
      >
        <DropZone onFiles={(f) => send(f, 'carousel')} busy={busy} />
        <div className="photo-grid">
          {data.carousel.map((p, i) => (
            <figure
              key={p.file}
              className={`photo-tile ${drag.over === i ? 'drop-target' : ''} ${drag.from === i ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDrag({ from: i, over: i })}
              onDragOver={(e) => { e.preventDefault(); setDrag((d) => ({ ...d, over: i })); }}
              onDragEnd={() => setDrag({ from: null, over: null })}
              onDrop={(e) => { e.preventDefault(); dropAt(i); }}
            >
              <img src={p.url} alt="" loading="lazy" />
              <figcaption>
                <span className="muted">{i + 1}</span>
                <button className="link-danger" onClick={() => remove(p.file)} disabled={busy}>Supprimer</button>
              </figcaption>
            </figure>
          ))}
          {data.carousel.length === 0 && <p className="muted">Aucune photo : le carrousel est masqué sur la page d'accueil.</p>}
        </div>
      </Section>

      {/* ── Emplacements uniques ───────────────────────────────────────────── */}
      {[
        { slot: 'hero', title: 'Bandeau du haut', hint: "Grande photo derrière le titre, en haut de la page d'accueil. Format paysage conseillé." },
        { slot: 'presentation', title: 'Photo de présentation', hint: 'Photo de la section « Le lieu », à côté du texte de présentation.' },
      ].map(({ slot, title, hint }) => {
        const current = data[slot];
        return (
          <Section key={slot} title={title} hint={hint}
            aside={current ? <button className="outline" onClick={() => clearSlot(slot)} disabled={busy}>Retirer</button> : <span className="badge grey">photo d'origine</span>}
          >
            {current ? (
              <div className="photo-slot">
                <img src={current.url} alt="" />
                <DropZone onFiles={(f) => send(f, slot)} busy={busy} multiple={false} label="Remplacer cette photo" />
              </div>
            ) : (
              <DropZone onFiles={(f) => send(f, slot)} busy={busy} multiple={false} />
            )}
          </Section>
        );
      })}

      {/* ── Photos des espaces ─────────────────────────────────────────────── */}
      <Section
        title="Photos des espaces"
        hint="Chaque salle porte sa propre photo. Elle se règle aussi depuis l'écran Espaces."
      >
        <div className="photo-grid">
          {data.spaces.map((s) => (
            <figure key={s.id} className="photo-tile">
              {s.url ? <img src={s.url} alt={s.name} loading="lazy" /> : <div className="photo-ph"><span>📷 {s.name}</span></div>}
              <figcaption>
                <strong style={{ fontSize: 13 }}>{s.name}</strong>
                {s.photo && <button className="link-danger" onClick={() => setSpacePhoto(s.id, null)} disabled={busy}>Retirer</button>}
              </figcaption>
              <SpaceUpload spaceId={s.id} onDone={load} flash={flash} />
            </figure>
          ))}
          {data.spaces.length === 0 && <p className="muted">Aucun espace actif.</p>}
        </div>
      </Section>
    </div>
  );
}

/** Bouton d'envoi d'une photo pour un espace : envoi puis rattachement à la salle. */
function SpaceUpload({ spaceId, onDone, flash }) {
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const { blob, name } = await prepareImage(file);
      // Sans `slot` : la photo rejoint la bibliothèque, puis on la rattache à la salle.
      const up = await api.upload('/admin/media', blob, name);
      await api.put(`/admin/spaces/${spaceId}`, { photo: up.file });
      await onDone();
      flash('ok', 'Photo de l\'espace mise à jour.');
    } catch (err) { flash('error', msg(err.code)); } finally { setBusy(false); }
  };

  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <button className="outline" style={{ width: '100%' }} onClick={() => input.current?.click()} disabled={busy}>
        {busy ? 'Envoi…' : 'Choisir une photo'}
      </button>
    </>
  );
}
