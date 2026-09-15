/**
 * Tailwind is compiled at BUILD time, not in the browser.
 *
 * The Play CDN used to do this at runtime, which meant a phone on mobile data
 * rendered the page before the compiler arrived — an unstyled, overflowing
 * layout for however long the 400 KB download took. Building produces a small
 * static stylesheet that applies on first paint.
 *
 * Colours resolve to CSS custom properties holding raw RGB channels, so the
 * alpha modifiers (bg-surface/70) keep working and the whole palette can be
 * swapped by the theme without regenerating any CSS.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  // Class names live in the HTML *and* in the JS that renders event cards.
  // Missing the JS here would silently drop those utilities from the build.
  content: [
    './views/**/*.html',
    './public/js/**/*.js',
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg:         token('bg'),
        surface:    token('surface'),
        surface2:   token('surface-2'),
        deep:       token('deep'),
        deep2:      token('deep-2'),
        ink:        token('text'),
        muted:      token('muted'),
        ondeep:     token('on-deep'),
        line:       token('border'),
        lineStrong: token('border-strong'),
        sky:     { brand: token('brand-sky'),   dark: token('brand-sky-dk') },
        magenta: { brand: token('brand-magenta'), fill: token('fill-magenta') },
        amber:   { brand: token('brand-amber'), deep: token('brand-amber-dk') },
      },
      // 8 and 12 are not on Tailwind's default opacity scale. The design uses
      // both for very light tints, and without these the utilities are silently
      // dropped from the build rather than erroring.
      opacity: { 8: '0.08', 12: '0.12' },
      borderOpacity: { 8: '0.08', 12: '0.12' },
      backgroundOpacity: { 8: '0.08', 12: '0.12' },
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
        mono:    ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
