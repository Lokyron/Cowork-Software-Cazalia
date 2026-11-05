import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDateTime } from '../time.js';

const eur = (cents) => ((Number(cents) || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

function StatusBadge({ status }) {
  if (status === 'refunded') return <span className="badge red">Remboursé</span>;
  if (status === 'partially_refunded') return <span className="badge">Partiel. remboursé</span>;
  return <span className="badge green">Payé</span>;
}

// Historique des paiements en ligne du membre (audit §1 — transactions Stripe).
// Les montants et statuts proviennent des commandes de réservation (source de
// vérité des encaissements) ; le reçu renvoie vers le justificatif Stripe.
export default function MemberPayments() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.get('/transactions/me')
      .then((r) => setTransactions(r.transactions || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Mes paiements</h1>
          <p className="subtitle" style={{ margin: 0 }}>Historique de vos paiements de réservation en ligne.</p>
        </div>
        <Link to="/mon-espace"><button className="outline small">← Mon espace</button></Link>
      </div>

      {loading ? (
        <p className="muted">Chargement…</p>
      ) : error ? (
        <div className="alert error">Impossible de charger vos paiements pour le moment.</div>
      ) : transactions.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 28 }}>
          <p className="muted" style={{ margin: '0 0 12px' }}>Aucun paiement pour le moment.</p>
          <Link to="/reserver"><button>Réserver un espace</button></Link>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Réservation</th>
                  <th>Statut</th>
                  <th style={{ textAlign: 'right' }}>Montant</th>
                  <th style={{ textAlign: 'right' }}>Reçu</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDateTime(t.created_at)}</td>
                    <td>
                      {t.spaces || '—'}
                      {t.reservations_count > 1 && <span className="muted"> · {t.reservations_count} créneaux</span>}
                    </td>
                    <td>
                      <StatusBadge status={t.status} />
                      {t.refunded_cents > 0 && t.status !== 'refunded' && (
                        <span className="muted seats"> −{eur(t.refunded_cents)}</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{eur(t.amount_cents)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {t.receipt_url
                        ? <a href={t.receipt_url} target="_blank" rel="noopener noreferrer">Voir le reçu ↗</a>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Le reçu est fourni par Stripe, notre prestataire de paiement. En cas de remboursement,
            le statut est mis à jour automatiquement.
          </p>
        </div>
      )}
    </div>
  );
}
