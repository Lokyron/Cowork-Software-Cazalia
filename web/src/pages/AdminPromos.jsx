import { useEffect, useState, useCallback, Fragment } from 'react';
import { api, msg } from '../api.js';

// Page « passerelle » : les codes promo sont créés et gérés dans le dashboard
// Stripe (source de vérité). Cette page ne fait que SYNCHRONISER et AFFICHER : elle
// n'édite rien. Elle sert de raccourci pour visualiser les codes et comprendre
// comment ils s'appliquent dans le tunnel de réservation.

const TARIF_LABEL = {
  journee: 'Formule Journée', demi_journee: 'Formule Demi-journée', heure: 'Formule Heure', '': 'Toutes les formules',
};

const fmtDate = (iso) => {
  if (!iso) return 'Sans expiration';
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
};
const eur = (cents) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtReduction = (p) => (p.reduction_type === 'percent' ? `−${p.reduction_value} %` : `−${eur(p.reduction_value)}`);

// Phrase lisible décrivant le fonctionnement d'un code.
function explain(p) {
  const bits = [];
  bits.push(
    p.reduction_type === 'percent'
      ? `Réduction de ${p.reduction_value} %`
      : `Réduction de ${eur(p.reduction_value)}`,
  );
  bits.push(p.tarif_restriction ? `sur la ${TARIF_LABEL[p.tarif_restriction].toLowerCase()}` : 'sur tout le panier éligible');
  if (p.reduction_type === 'amount' && p.tarif_restriction) {
    bits.push('(plafonnée au sous-total de cette formule — donc une seule formule offerte même si le panier en contient plusieurs)');
  }
  const limits = [];
  limits.push(p.max_per_user != null ? `${p.max_per_user} fois par personne` : 'sans limite par personne');
  if (p.max_redemptions != null) limits.push(`${p.max_redemptions} au total`);
  return `${bits.join(' ')}. Utilisable ${limits.join(', ')}.`;
}

export default function AdminPromos() {
  const [promos, setPromos] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/admin/promos'); // déclenche la synchro Stripe côté serveur
      setPromos(r.promos || []);
    } catch (err) {
      setError(err.code === 'STRIPE_NON_CONFIGURE'
        ? 'Stripe n’est pas configuré : impossible de synchroniser les codes promo.'
        : msg(err.code));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex-between">
        <h1>Codes promo</h1>
        <button type="button" className="outline" onClick={load} disabled={loading}>
          {loading ? 'Synchronisation…' : '↻ Rafraîchir depuis Stripe'}
        </button>
      </div>
      <p className="subtitle">
        Les codes promo sont <strong>créés et gérés dans Stripe</strong> (dashboard &rsaquo; Produits &rsaquo;
        Codes promotionnels). Cette page est une <strong>passerelle en lecture seule</strong>&nbsp;: elle
        reflète ce qui existe dans Stripe et explique comment chaque code s’applique. Toute création ou
        modification se fait dans Stripe.
      </p>

      {error && <div className="alert error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Comment fonctionnent les codes</h2>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li>Le client saisit le code <strong>dans le panier de réservation</strong>, pas sur la page de
            paiement Stripe (la saisie libre y est désactivée).</li>
          <li><strong>Restriction de formule</strong> : si le coupon Stripe est limité à un produit
            (« Cazalia – Formule Journée »…), la remise ne s’applique qu’aux lignes de cette formule.</li>
          <li><strong>Montant fixe (ex. −20 €)</strong> : la remise est plafonnée au sous-total éligible.
            Sur la formule Journée (20 €), cela revient à offrir <strong>une seule journée</strong>, même si
            le panier en contient plusieurs.</li>
          <li><strong>Limite par personne</strong> : Stripe ne la gère pas nativement. Pour l’activer,
            ajoutez une métadonnée <code>max_per_user</code> (ex. <code>1</code>) sur le <strong>coupon</strong>
            ou sur le code promo dans Stripe. Absente = illimité par personne. C’est l’application qui la
            fait respecter (par compte membre).</li>
          <li><strong>Limite globale et expiration</strong> sont lues directement depuis le coupon / code
            Stripe.</li>
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Codes dans Stripe</h2>
        {loading && !promos.length ? (
          <p className="muted">Synchronisation avec Stripe…</p>
        ) : !promos.length ? (
          <p className="muted">Aucun code promo dans Stripe pour le moment. Créez-en un depuis le dashboard Stripe.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Réduction</th><th>Formule</th><th>Usages</th><th>Par pers.</th><th>Expire</th><th>État</th><th></th>
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <Fragment key={p.id}>
                  <tr>
                    <td><code className="voucher-code" style={{ fontSize: 14, padding: '2px 8px' }}>{p.code}</code></td>
                    <td>{fmtReduction(p)}</td>
                    <td>{TARIF_LABEL[p.tarif_restriction || '']}</td>
                    <td>{p.used != null ? p.used : '-'}{p.max_redemptions ? ` / ${p.max_redemptions}` : ''}</td>
                    <td>{p.max_per_user ? p.max_per_user : '∞'}</td>
                    <td>{fmtDate(p.expires_at)}</td>
                    <td><span className={`badge ${p.active ? 'green' : 'grey'}`}>{p.active ? 'Actif' : 'Inactif'}</span></td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button type="button" className="ghost small" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                        {openId === p.id ? 'Masquer' : 'Détails'}
                      </button>
                    </td>
                  </tr>
                  {openId === p.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--surface-2, #f7f7f8)', fontSize: 14 }}>
                        <p style={{ margin: '4px 0' }}>{explain(p)}</p>
                        <p className="muted" style={{ margin: '4px 0', fontSize: 13 }}>
                          Usages déjà enregistrés (côté application) : <strong>{p.used ?? 0}</strong>.
                          {p.max_per_user != null && ' La limite « par personne » est comptée par compte membre.'}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
