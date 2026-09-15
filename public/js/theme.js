/* EthiCraft Club — theme controller.
 *
 * The *resolution* half of this (reading storage, stamping data-theme) is
 * duplicated inline in each page's <head> so it runs before first paint.
 * Without that, a dark-mode visitor gets a white flash on every navigation.
 * This file handles everything that can safely wait until after paint:
 * the toggle button, cross-tab sync, and following the OS setting.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'ethicraft-theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  /** The visitor's OS-level day/night setting. */
  const systemTheme = () => (media.matches ? 'dark' : 'light');

  function stored() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;   // Safari private mode throws on access
    }
  }

  function apply(theme, { animate = false } = {}) {
    if (animate) {
      document.body.classList.add('is-theme-switching');
      setTimeout(() => document.body.classList.remove('is-theme-switching'), 400);
    }
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;

    // Keep the browser UI (address bar, form controls) in step.
    // Two media-scoped theme-color tags ship in the HTML for the pre-JS case;
    // once the visitor picks a theme explicitly, drive a single tag instead.
    document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => {
      if (i === 0) {
        m.removeAttribute('media');
        m.setAttribute('content', theme === 'dark' ? '#0a0e17' : '#fdf9f0');
      } else {
        m.remove();
      }
    });

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.setAttribute('title', theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode');
    });
  }

  function set(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch { /* storage unavailable - theme still applies for this page */ }
    apply(theme, { animate: true });
  }

  // Sync the toggle's pressed state with whatever the inline head script chose.
  apply(root.getAttribute('data-theme') || stored() || systemTheme());

  // Follow the OS live, but only while the visitor hasn't overridden it.
  media.addEventListener('change', () => {
    if (!stored()) apply(systemTheme(), { animate: true });
  });

  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-theme-toggle]');
    if (!button) return;
    set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // Another tab changed the preference - match it.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
      apply(e.newValue, { animate: true });
    }
  });
})();
