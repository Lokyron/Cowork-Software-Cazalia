// `dataVersion` (src/api.js) : compteur d'écritures qui invalide le cache du calendrier
// (`DatePicker`) quand le panier ou une réservation change.
//   cd web && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, dataVersion } from '../src/api.js';

const realFetch = globalThis.fetch;
const stub = (status, body) => { globalThis.fetch = async () => ({ ok: status < 400, status, json: async () => body }); };
test.afterEach(() => { globalThis.fetch = realFetch; });

test('dataVersion : une écriture réussie incrémente, une lecture non', async () => {
  const v0 = dataVersion();
  stub(200, { days: [] });
  await api.get('/availability/month?x=1');
  assert.equal(dataVersion(), v0);
  stub(200, { cart: {} });
  await api.post('/cart', { space_id: 1 });
  assert.equal(dataVersion(), v0 + 1);
  await api.del('/cart/3');
  assert.equal(dataVersion(), v0 + 2);
});

test('dataVersion : une écriture REFUSÉE (409 COMPLET) ou en échec réseau incrémente aussi', async () => {
  const v0 = dataVersion();
  stub(409, { error: 'COMPLET' });
  await assert.rejects(api.post('/cart', {}), (e) => e.code === 'COMPLET');
  assert.equal(dataVersion(), v0 + 1);
  globalThis.fetch = async () => { throw new TypeError('réseau'); };
  await assert.rejects(api.patch('/admin/reservations/1', {}));
  assert.equal(dataVersion(), v0 + 2);
});
