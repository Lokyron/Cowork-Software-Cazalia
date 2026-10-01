import { useEffect, useRef } from 'react';

// Fond décoratif : blobs colorés flous + grille subtile, avec parallaxe légère
// pilotée par la souris et le scroll (transforms GPU, throttlées en rAF).
export default function Background() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    let px = 0;
    let py = 0;
    let sy = 0;

    const apply = () => {
      raf = 0;
      el.style.setProperty('--px', px.toFixed(3));
      el.style.setProperty('--py', py.toFixed(3));
      el.style.setProperty('--sy', sy.toFixed(1));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const onMove = (e) => {
      px = (e.clientX / window.innerWidth - 0.5) * 2; // -1 .. 1
      py = (e.clientY / window.innerHeight - 0.5) * 2;
      schedule();
    };
    const onScroll = () => {
      sy = window.scrollY || 0;
      schedule();
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="bg" ref={ref} aria-hidden="true">
      <span className="blob blob-1" />
      <span className="blob blob-2" />
      <span className="blob blob-3" />
      <span className="bg-grid" />
    </div>
  );
}
