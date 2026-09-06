'use strict';

const { URL } = require('url');
const dns = require('dns');
const net = require('net');
const { promisify } = require('util');
const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

// Plages IP privées / locales / loopback / link-local / documentation.
const PRIVATE_RANGES = [
  { start: '127.0.0.0', end: '127.255.255.255' },     // loopback
  { start: '10.0.0.0', end: '10.255.255.255' },       // private
  { start: '172.16.0.0', end: '172.31.255.255' },     // private
  { start: '192.168.0.0', end: '192.168.255.255' },   // private
  { start: '169.254.0.0', end: '169.254.255.255' },   // link-local
  { start: '0.0.0.0', end: '0.255.255.255' },         // unspecified
  { start: '100.64.0.0', end: '100.127.255.255' },    // carrier-grade NAT
  { start: '198.18.0.0', end: '198.19.255.255' },     // benchmark
  { start: '::1', end: '::1' },                        // IPv6 loopback
];

function ipToLong(ip) {
  if (net.isIP(ip) !== 4) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const n = ipToLong(ip);
  if (n === null) return false;
  for (const range of PRIVATE_RANGES) {
    if (net.isIP(range.start) === 4) {
      const start = ipToLong(range.start);
      const end = ipToLong(range.end);
      if (start !== null && end !== null && n >= start && n <= end) return true;
    }
  }
  return false;
}

async function resolveHostnameToIps(hostname) {
  const ips = [];
  try {
    const v4 = await resolve4(hostname).catch(() => []);
    ips.push(...v4);
  } catch { /* ignore */ }
  try {
    const v6 = await resolve6(hostname).catch(() => []);
    ips.push(...v6);
  } catch { /* ignore */ }
  return ips;
}

/**
 * Valide qu'une URL distante est sûre pour un fetch réseau.
 * Bloque:
 *  - protocoles non autorisés (seul http/https)
 *  - localhost, IP privées, link-local, IPv6 loopback/link-local
 *  - redirections vers destinations interdites
 *
 * @param {string} url - URL à valider
 * @param {object} [opts]
 * @param {string[]} [opts.allowedHosts] - allowlist de hostnames autorisés (ex: ['leboncoin.fr'])
 * @param {boolean} [opts.checkRedirect=true] - vérifier la redirection finale
 * @param {Response} [opts.response] - réponse après redirection pour re-valider
 * @returns {{ safe: boolean, reason?: string }}
 */
async function validateRemoteUrl(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'URL invalide' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Protocole non autorisé: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // Bloque les hostnames locaux explicites.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { safe: false, reason: `Hostname local interdit: ${hostname}` };
  }

  // Si une IP est fournie directement, vérifie les plages privées.
  if (net.isIP(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `IP privée/interdite: ${hostname}` };
    }
    if (net.isIP(hostname) === 6 && hostname === '::1') {
      return { safe: false, reason: 'IPv6 loopback interdite' };
    }
  } else {
    // Résolution DNS pour vérifier les IPs associées.
    const ips = await resolveHostnameToIps(hostname);
    for (const ip of ips) {
      if (isPrivateIPv4(ip)) {
        return { safe: false, reason: `Résolution DNS vers IP privée: ${hostname} -> ${ip}` };
      }
    }
  }

  // Allowlist: si fournie, le hostname doit y figurer.
  if (Array.isArray(opts.allowedHosts) && opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.some((h) => {
      if (h.startsWith('*.')) {
        const suffix = h.slice(2);
        return hostname === suffix || hostname.endsWith('.' + suffix);
      }
      return hostname === h;
    });
    if (!allowed) {
      return { safe: false, reason: `Hostname hors allowlist: ${hostname}` };
    }
  }

  // Vérification post-redirection: si une réponse est fournie, s'assurer
  // que l'URL finale reste autorisée.
  if (opts.checkRedirect !== false && opts.response && opts.response.url) {
    const finalUrl = opts.response.url;
    if (finalUrl !== url) {
      const finalCheck = await validateRemoteUrl(finalUrl, { ...opts, checkRedirect: false });
      if (!finalCheck.safe) {
        return { safe: false, reason: `Redirection vers destination interdite: ${finalCheck.reason}` };
      }
    }
  }

  return { safe: true };
}

module.exports = { validateRemoteUrl, isPrivateIPv4, resolveHostnameToIps, PRIVATE_RANGES };
