'use strict';

const net = require('node:net');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * The visitor's own address, for the rate limits and the login lockout.
 *
 * In production every request reaches the app through Cloudflare, which
 * Render's edge runs on. There `req.ip` is one of Cloudflare's addresses: it is
 * shared by everyone Cloudflare routes, and it changes between one request and
 * the next. Limits keyed on it were shared with strangers and spread thin over
 * many addresses. Cloudflare puts the visitor's address in CF-Connecting-IP,
 * replacing any copy the visitor sent, so the header can be trusted there.
 *
 * Elsewhere (local runs, or the VPS setup, whose Caddyfile strips the header)
 * this falls back to `req.ip`.
 */
function clientIp(req) {
  const forwarded = req.get('cf-connecting-ip');
  if (forwarded && net.isIP(forwarded)) return forwarded;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * The same, as a key for counting requests. IPv6 addresses are grouped by /56,
 * so one visitor cannot step around a limit by moving between their own
 * addresses.
 */
function clientKey(req) {
  return ipKeyGenerator(clientIp(req));
}

module.exports = { clientIp, clientKey };
