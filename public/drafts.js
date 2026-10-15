// Browser-local drafts; no API call or model run. Scoped to the company's bound manager.
let scope = 'unbound';
let restoring = false;
export function draftScope(value) { scope = value || 'unbound'; }
function key(form) { return form?.dataset?.draftKey ? `company.draft:${scope}:${form.dataset.draftKey}` : null; }
function read(form) { try { return JSON.parse(sessionStorage.getItem(key(form)) || 'null'); } catch { return null; } }
export function rememberForm(form, { open } = {}) {
  const id = key(form); if (!id || restoring || form.dataset.draftDirty === 'saved') return;
  const values = [...form.querySelectorAll('input[name],textarea[name],select[name]')].filter((el) => !['password', 'file', 'submit'].includes(el.type)).map((el) => ({ name: el.name, type: el.type, value: el.value, checked: el.checked }));
  const modal = form.closest('dialog');
  try { sessionStorage.setItem(id, JSON.stringify({ values, requestId: form.dataset.requestId || '', open: open ?? Boolean(modal?.open), dirty: true })); } catch { /* Storage can be unavailable. */ }
}
export function captureDrafts(container) { container.querySelectorAll('[data-draft-key]').forEach((f) => { if (f.dataset.draftDirty === 'true' || f.closest('dialog')?.open) rememberForm(f); }); }
export function restoreDrafts(container) {
  restoring = true;
  try {
    container.querySelectorAll('[data-draft-key]').forEach((form) => {
      const saved = read(form); if (!saved) return;
      for (const el of form.querySelectorAll('input[name],textarea[name],select[name]')) {
        const row = saved.values.find((r) => r.name === el.name && (['checkbox', 'radio'].includes(el.type) ? r.value === el.value : true));
        if (!row) continue;
        if (['checkbox', 'radio'].includes(el.type)) el.checked = Boolean(row.checked);
        else if (el.value !== row.value && (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === row.value))) el.value = row.value;
      }
      if (saved.requestId) form.dataset.requestId = saved.requestId;
      form.dataset.draftDirty = 'true';
      const dialog = form.closest('dialog');
      if (saved.open && dialog && !dialog.open) dialog.showModal();
      const session = form.querySelector('[name="sessionId"]');
      if (session) form.querySelector('.new-session')?.classList.toggle('hidden', session.value !== 'new');
    });
  } finally { restoring = false; }
}
export function forgetDraft(form) {
  try { if (key(form)) sessionStorage.removeItem(key(form)); } catch { /* Storage can be unavailable. */ }
  if (form?.dataset) form.dataset.draftDirty = 'saved';
}
