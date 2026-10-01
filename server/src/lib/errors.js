// Erreur métier : un Error dont `code` est traduit en statut HTTP par
// `sendBusinessError` (middleware). `extra` permet d'attacher des champs
// renvoyés au client (ex. `slotIndex` pour pointer un créneau fautif).
export function fail(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}
