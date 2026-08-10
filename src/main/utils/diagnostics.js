// =========================================================================
// FICHIER : src/main/utils/diagnostics.js
// Helpers de diagnostic réutilisables pour produire des logs détaillés et
// exploitables lors du débogage. Partagé entre le main process et le pipeline
// sous-processus (fork) via un require relatif.
// =========================================================================

'use strict';

// Masque partiellement une clé API / valeur sensible pour les logs.
function redact(value, visibleChars = 4) {
  if (!value || typeof value !== 'string') return '(vide)';
  if (value.length <= visibleChars) return '***';
  return `${value.slice(0, visibleChars)}…${value.slice(-2)} (longueur ${value.length})`;
}

// Tronque un texte long sans perdre le contexte (début + fin + taille totale).
function truncate(text, maxLen = 200) {
  if (text == null) return '(null)';
  const s = typeof text === 'string' ? text : String(text);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[+${s.length - maxLen} caractères]`;
}

// JSON.stringify sécurisé : ne jette jamais, indique les types circulaires.
function safeStringify(obj, indent = 0) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[référence circulaire]';
        seen.add(value);
      }
      if (typeof value === 'bigint') return `[BigInt ${value.toString()}]`;
      return value;
    }, indent);
  } catch (err) {
    return `[sérialisation impossible : ${err.message}]`;
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '?';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function formatMs(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Produit un résumé compact d'une liste d'annonces (sans tout logger).
function summarizeAds(ads) {
  if (!Array.isArray(ads)) return '(pas un tableau)';
  if (ads.length === 0) return '0 annonce';
  const withPrice = ads.filter((a) => a.price != null && !isNaN(parseFloat(a.price))).length;
  const withDesc = ads.filter((a) => a.description).length;
  const withUrl = ads.filter((a) => a.url).length;
  const withImages = ads.filter((a) => Array.isArray(a.images) && a.images.length > 0).length;
  const ids = ads.slice(0, 5).map((a) => a.id).filter(Boolean);
  const sample = ads[0] || {};
  return `${ads.length} annonce(s) | prix: ${withPrice} | description: ${withDesc} | url: ${withUrl} | images: ${withImages} | premiers IDs: [${ids.join(', ')}${ads.length > 5 ? ', …' : ''}] | exemple titre: "${truncate(sample.title, 40)}"`;
}

// Résumé des entrées d'un HAR pour comprendre ce qui a été capturé.
function summarizeHarEntries(entries) {
  if (!Array.isArray(entries)) return '(pas un tableau)';
  if (entries.length === 0) return '0 entrée HAR';
  const byMime = {};
  let withBody = 0;
  let totalSize = 0;
  let errorStatus = 0;
  for (const e of entries) {
    const res = e.response || {};
    const mime = (res.content && res.content.mimeType) || 'inconnu';
    const cat = mime.split('/')[0] || 'inconnu';
    byMime[cat] = (byMime[cat] || 0) + 1;
    if (res.content && res.content.text) withBody++;
    if (typeof res.status === 'number' && res.status >= 400) errorStatus++;
  }
  const breakdown = Object.entries(byMime).map(([k, v]) => `${k}:${v}`).join(', ');
  return `${entries.length} entrée(s) | avec corps: ${withBody} | erreurs HTTP ≥400: ${errorStatus} | types: {${breakdown}}`;
}

// Compte les éléments d'un tableau selon un critère (retourne un objet cat→nombre).
function countBy(items, fn) {
  const result = {};
  for (const item of items || []) {
    const key = fn(item);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function describeError(err) {
  if (!err) return "(pas d'erreur)";
  const parts = [err.message || '(sans message)'];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.syscall) parts.push(`syscall=${err.syscall}`);
  if (err.status) parts.push(`status=${err.status}`);
  return parts.join(' | ');
}

module.exports = {
  redact,
  truncate,
  safeStringify,
  formatBytes,
  formatMs,
  summarizeAds,
  summarizeHarEntries,
  countBy,
  describeError,
};
