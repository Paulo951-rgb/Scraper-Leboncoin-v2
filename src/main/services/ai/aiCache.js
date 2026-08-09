'use strict';

/**
 * Cache IA persistant sur disque.
 * Évite de re-demander à l'IA d'analyser une annonce déjà vue (même list_id).
 * Le cache est stocké dans ai-cache.json et indexé par list_id.
 */
const path = require('path');
const fs = require('fs');

const CACHE_PATH = path.join(__dirname, '..', '..', 'config', 'ai-cache.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
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
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AiCache] Sauvegarde impossible :', err.message);
  }
}

function get(listId) {
  if (!listId) return null;
  const cache = _load();
  return cache[String(listId)] || null;
}

function set(listId, specs) {
  if (!listId || !specs) return;
  const cache = _load();
  cache[String(listId)] = {
    specs,
    cachedAt: Date.now(),
  };
  _save();
}

function stats() {
  const cache = _load();
  return { entries: Object.keys(cache).length };
}

function clear() {
  _cache = {};
  try { fs.unlinkSync(CACHE_PATH); } catch { /* n'existe pas */ }
}

module.exports = { get, set, stats, clear };
