'use strict';

/**
 * Cache IA persistant sur disque.
 * Évite de re-demander à l'IA d'analyser une annonce déjà vue (même list_id).
 * Le cache est stocké dans ai-cache.json et indexé par list_id.
 */
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync } = require('../../utils/helpers');

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
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 1000;

function _saveNow() {
  if (!_cache) return; // rien à écrire si jamais chargé
  try {
    fs.mkdirSync(path.dirname(getCachePath()), { recursive: true });
    // Écriture atomique : un crash pendant fs.writeFileSync laissait
    // ai-cache.json tronqué → tout le cache IA perdu (re-analyses coûteuses).
    atomicWriteFileSync(getCachePath(), JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AiCache] Sauvegarde impossible :', err.message);
  }
}

function _flushSave() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _saveNow();
}

// Sauvegarde debouncée : pendant une analyse par lots (concurrency xN), chaque
// annonce complétée déclenche un set(). Écrire tout le cache (jusqu'à 5000
// entrées) en synchrone à chaque set bloquerait l'event-loop principal et
// ferait saccader la progression IPC. On coalesce les écritures : un seul flush
// disque au plus SAVE_DEBOUNCE_MS après la dernière écriture. En cas de crash,
// on perd au pire la dernière seconde de mises en cache (cache = optimisation
// régénérable, pas une donnée critique).
function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _saveNow();
  }, SAVE_DEBOUNCE_MS);
}

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
  _scheduleSave();
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
  _flushSave(); // écrit toute écriture pendante avant de vider
  _cache = {};
  try { fs.unlinkSync(getCachePath()); } catch { /* n'existe pas */ }
}

module.exports = { get, set, stats, clear, _flushSave };
