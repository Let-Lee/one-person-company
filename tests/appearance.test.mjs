import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/appearance.js', import.meta.url), 'utf8');
function page({ saved = null, dark = false, unavailable = false } = {}) {
  const listeners = {}, mediaListeners = {}, storage = { value: saved };
  const buttons = ['light', 'dark', 'system'].map((mode) => ({ dataset: { colorMode: mode }, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }));
  const document = { documentElement: { dataset: {} }, querySelectorAll: () => buttons, addEventListener: (name, fn) => listeners[name] = fn };
  const media = { matches: dark, addEventListener: (name, fn) => mediaListeners[name] = fn };
  const window = { matchMedia: () => media, addEventListener: (name, fn) => listeners[name] = fn };
  const localStorage = { getItem() { if (unavailable) throw Error('disabled'); return storage.value; }, setItem(_key, value) { if (unavailable) throw Error('disabled'); storage.value = value; } };
  vm.runInNewContext(source, { document, window, localStorage });
  return { root: document.documentElement.dataset, buttons, storage,
    choose(mode) { listeners.click({ target: { closest: () => buttons.find((b) => b.dataset.colorMode === mode) } }); },
    system(dark) { media.matches = dark; mediaListeners.change(); },
    otherTab(value) { listeners.storage({ key: 'workbench.appearance', newValue: value }); } };
}

test('appearance is applied before rendering and follows system only while system is selected', () => {
  const p = page({ dark: false });
  assert.equal(p.root.theme, 'light'); assert.equal(p.root.themeMode, 'system');
  p.system(true); assert.equal(p.root.theme, 'dark');
  p.choose('light'); p.system(true);
  assert.equal(p.root.theme, 'light'); assert.equal(p.root.themeMode, 'light');
  assert.equal(p.buttons.filter((b) => b.attributes['aria-pressed'] === 'true').length, 1);
});

test('a chosen appearance survives reopening and synchronizes browser tabs', () => {
  const p = page(); p.choose('dark');
  assert.equal(page({ saved: p.storage.value }).root.theme, 'dark');
  p.otherTab('light'); assert.equal(p.root.theme, 'light');
  p.otherTab(null); assert.equal(p.root.themeMode, 'system');
});

test('invalid or unavailable local storage never blocks the app or the appearance controls', () => {
  assert.equal(page({ saved: 'invalid' }).root.themeMode, 'system');
  const p = page({ unavailable: true }); p.choose('dark');
  assert.equal(p.root.theme, 'dark');
});
