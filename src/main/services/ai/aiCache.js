'use strict';

/**
 * Cache IA persistant sur disque.
 * Évite de re-demander à l'IA d'analyser une annonce déjà vue (même list_id).
 * Le cache est stocké dans ai-cache.json et indexé par list_id.
 */
const path = require('path');
const fs = require('fs');

let _cachePath = null;
function getCachePath() {
  if (_cachePath) return _cachePath;
  let base;
  try {
    const { app } = require('electron');
    base = app.getPath('userData');
  } catch {
    // Hors Electron (tests) : dossier local.
    base = path.join(process.cwd(), 'output');
  }
  _cachePath = path.join(base, 'ai-cache.json');
  return _cachePath;
}
// Plafond d'entrées pour éviter une croissance infinie du cache sur disque
// (au-delà, on évite les entrées les plus anciennes par cachedAt).
const MAX_ENTRIES = 5000;

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(getCachePath())) {
      _cache = JSON.parse(fs.readFileSync(getCachePath(), 'utf8'));
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(getCachePath()), { recursive: true });
    fs.writeFileSync(getCachePath(), JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AiCache] Sauvegarde impossible :', err.message);
  }
}

function _key(listId, prefix) {
  return prefix ? `${prefix}:${String(listId)}` : String(listId);
}

function get(listId, prefix) {
  if (!listId) return null;
  const cache = _load();
  const entry = cache[_key(listId, prefix)];
  // Renvoie la valeur mise en cache (entry.specs), pas le wrapper
  // { specs, cachedAt } — sinon les appelants (AdAnalyzer/MarketValueAnalyzer)
  // reçoivent un objet sans les champs attendus (identifiedProduct, realValue,
  // _fallback...) et la détection des fallbacks échoue silencieusement.
  return entry && entry.specs != null ? entry.specs : null;
}

function set(listId, specs, prefix) {
  if (!listId || !specs) return;
  const cache = _load();
  cache[_key(listId, prefix)] = {
    specs,
    cachedAt: Date.now(),
  };
  _evictIfNeeded(cache);
  _save();
}

// Éviction des entrées les plus anciennes si le cache dépasse le plafond.
function _evictIfNeeded(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ENTRIES) return;
  // Trie par cachedAt croissant, supprime les (n - MAX) plus anciennes.
  keys
    .map((k) => [k, cache[k].cachedAt || 0])
    .sort((a, b) => a[1] - b[1])
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach(([k]) => { delete cache[k]; });
}

function stats() {
  const cache = _load();
  return { entries: Object.keys(cache).length };
}

function clear() {
  _cache = {};
  try { fs.unlinkSync(getCachePath()); } catch { /* n'existe pas */ }
}

module.exports = { get, set, stats, clear };
