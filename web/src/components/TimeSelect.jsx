// Sélecteur d'heure restreint aux quarts d'heure (00, 15, 30, 45).
// Remplace <input type="time"> pour empêcher tout choix hors quart d'heure.
const QUARTERS = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
})();

export default function TimeSelect({ value, ...rest }) {
  // Si une valeur héritée n'est pas un quart d'heure, on la garde affichable.
  const options = value && !QUARTERS.includes(value) ? [value, ...QUARTERS] : QUARTERS;
  return (
    <select value={value} {...rest}>
      {options.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}
