// Run before styles load so the saved appearance is applied on the first paint.
(() => {
  const key = 'workbench.appearance';
  const modes = new Set(['light', 'dark', 'system']);
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let mode = 'system';
  try { const saved = localStorage.getItem(key); if (modes.has(saved)) mode = saved; } catch { /* Private browsing can disable storage. */ }
  function apply() {
    root.dataset.themeMode = mode;
    root.dataset.theme = mode === 'system' ? system.matches ? 'dark' : 'light' : mode;
    document.querySelectorAll('[data-color-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.colorMode === mode)));
  }
  apply();
  system.addEventListener('change', () => { if (mode === 'system') apply(); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-color-mode]');
    if (!button || !modes.has(button.dataset.colorMode)) return;
    mode = button.dataset.colorMode;
    try { localStorage.setItem(key, mode); } catch { /* The current page still uses the chosen mode. */ }
    apply();
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    mode = modes.has(event.newValue) ? event.newValue : 'system';
    apply();
  });
})();
