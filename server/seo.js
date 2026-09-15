'use strict';

const { query } = require('./db');

const xmlEscape = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * robots.txt. The admin path is deliberately NOT listed as a Disallow rule —
 * robots.txt is public, so naming it there would advertise the one thing we
 * want left unadvertised. The page is noindex'd via a meta tag instead.
 */
function buildRobots({ origin }) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** sitemap.xml covering the home page and its sections. */
async function buildSitemap({ origin }) {
  const today = new Date().toISOString().slice(0, 10);
  let newest = today;
  try {
    const { rows } = await query(
      'SELECT MAX(updated_at) AS newest FROM events WHERE published = true');
    if (rows[0]?.newest) newest = new Date(rows[0].newest).toISOString().slice(0, 10);
  } catch {
    // A sitemap with today's date is better than a 500 if the database is asleep.
  }

  const urls = [
    { loc: `${origin}/`,          changefreq: 'weekly',  priority: '1.0' },
    { loc: `${origin}/#about`,    changefreq: 'monthly', priority: '0.8' },
    { loc: `${origin}/#modules`,  changefreq: 'monthly', priority: '0.8' },
    { loc: `${origin}/#events`,   changefreq: 'weekly',  priority: '0.9' },
    { loc: `${origin}/#speakers`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${origin}/#join`,     changefreq: 'monthly', priority: '0.8' },
  ];

  const body = urls.map(({ loc, changefreq, priority }) => `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <lastmod>${xmlEscape(newest)}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

module.exports = { buildRobots, buildSitemap, xmlEscape };
