// Paletas de cores: escolha guardada só neste aparelho. "Automático" segue o tema do aparelho.
const PAL_KEY = 'oldace.palette';
const PAL_VARS = ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'accent-text', 'sel', 'warn-bg', 'warn-line', 'warn-text', 'err-bg', 'err-line', 'ok-bg', 'ok-line'];
function palGet() { try { return localStorage.getItem(PAL_KEY) || 'auto'; } catch (_) { return 'auto'; } }
function palSet(id) { try { localStorage.setItem(PAL_KEY, id); } catch (_) { /* sem armazenamento */ } }
function applyPalette(id) {
  const root = document.documentElement, p = PALETTES.find(x => x.id === id);
  PAL_VARS.forEach(k => root.style.removeProperty('--' + k));
  if (!p) { root.style.removeProperty('color-scheme'); root.removeAttribute('data-palette'); root.removeAttribute('data-dark'); return; }
  PAL_VARS.forEach(k => root.style.setProperty('--' + k, p.v[k]));
  root.style.setProperty('color-scheme', p.dark ? 'dark' : 'light');
  root.setAttribute('data-palette', p.id);
  if (p.dark) root.setAttribute('data-dark', ''); else root.removeAttribute('data-dark');
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', p.v.accent);
}
applyPalette(palGet());   // antes da primeira pintura, para não piscar
