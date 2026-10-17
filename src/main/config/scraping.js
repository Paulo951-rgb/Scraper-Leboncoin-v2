'use strict';

/**
 * Constantes partagées du scraping.
 *
 * Ce module ne requiert PAS `electron` : il est importable aussi bien par le
 * main process que par le pipeline forké (sous-processus sans accès à `app`).
 * Il centralise les seuils/délais/presets auparavant dispersés entre
 * `leboncoin-pipeline.js`, `ipcHandlers.js` et `harCapturer.js`, afin d'éviter
 * les désynchronisations (une valeur modifiée d'un côté seulement).
 */

// ─────────────────────────────────────────────────────────────────────────────
// POLITIQUE DE SCRAPING FIXE (source unique de vérité)
// ─────────────────────────────────────────────────────────────────────────────
//
// La configuration de scraping n'est PLUS modifiable par l'utilisateur : elle
// est appliquée automatiquement au démarrage par TOUTES les couches (main
// process, pipeline forké, capture HAR). Ces valeurs sont des invariants
// garantis par des tests (test/regression.test.js).
//
//   concurrency : nombre MAXIMAL de tâches parallèles (jamais dépassé).
//   pageDelayMs : délai NOMINAL entre deux pages de recherche successives.
//
// Le délai de 400 ms est un délai nominal : il n'autorise JAMAIS à contourner
// une limitation explicite du site (403/429). En cas de blocage, la concurrence
// effective est réduite et un backoff progressif est appliqué (cf. rateLimiter).
const MAX_CONCURRENCY = 25;

const SCRAPING_POLICY = Object.freeze({
  mode: 'ultra-rapide',
  label: 'ULTRA RAPIDE',
  concurrency: MAX_CONCURRENCY,   // 25 tâches parallèles maximum
  pageDelayMs: 400,               // délai nominal entre pages de recherche
  // Délai de base de l'enrichissement des descriptions. Identique au délai
  // nominal : un baseDelay trop faible rendrait le backoff après blocage
  // minuscule (base × 2^N), donc inefficace face à une limitation de débit.
  enrichMinDelayMs: 400,
  enrichMaxDelayMs: 8000,
});

/**
 * Renvoie la politique de scraping active, validée et bornée.
 * La concurrence ne peut JAMAIS dépasser MAX_CONCURRENCY.
 * @returns {{mode:string,label:string,concurrency:number,pageDelayMs:number,enrichMinDelayMs:number,enrichMaxDelayMs:number}}
 */
function getScrapingPolicy() {
  return { ...SCRAPING_POLICY };
}

/**
 * Borne une concurrence demandée par un appelant (IPC, ancien script, preset)
 * à la limite absolue. Un renderer compromis ou un ancien paramètre persisté ne
 * peut donc pas relever la concurrence au-delà de MAX_CONCURRENCY.
 * @param {*} requested
 * @returns {number}
 */
function clampConcurrency(requested) {
  const n = parseInt(requested, 10);
  if (!Number.isFinite(n) || n < 1) return SCRAPING_POLICY.concurrency;
  return Math.min(n, MAX_CONCURRENCY);
}

// Presets historiques : conservés uniquement pour l'affichage / la
// rétro-compatibilité des anciens fichiers de configuration. Ils ne pilotent
// PLUS le scraping (cf. getScrapingPolicy). `getSpeedPreset()` renvoie
// désormais la politique fixe, quelle que soit la valeur demandée.
const SPEED_PRESETS = {
  moyen:          { concurrency: 10, minDelayMs: 500, maxDelayMs: 1000, mode: 'parallèle' },
  rapide:         { concurrency: 15, minDelayMs: 200, maxDelayMs: 600,  mode: 'parallèle' },
  'ultra-rapide': { concurrency: 25, minDelayMs: 400, maxDelayMs: 8000, mode: 'parallèle' },
};
const DEFAULT_SPEED = SCRAPING_POLICY.mode;

/**
 * @deprecated La vitesse n'est plus configurable. Renvoie toujours la politique
 * fixe, en conservant la forme { concurrency, minDelayMs, maxDelayMs, mode }
 * attendue par le pipeline.
 */
function getSpeedPreset() {
  return {
    concurrency: SCRAPING_POLICY.concurrency,
    minDelayMs: SCRAPING_POLICY.enrichMinDelayMs,
    maxDelayMs: SCRAPING_POLICY.enrichMaxDelayMs,
    mode: 'parallèle',
  };
}

// Valeurs par défaut du pipeline. La concurrence et les délais effectifs
// proviennent de la politique fixe (SCRAPING_POLICY) ; ces valeurs ne servent
// que de repli si le pipeline est utilisé en bibliothèque sans configuration.
const PIPELINE_DEFAULTS = {
  minDelayMs: SCRAPING_POLICY.enrichMinDelayMs,
  maxDelayMs: SCRAPING_POLICY.enrichMaxDelayMs,
  headless: false,
  outDir: '.',
  concurrency: SCRAPING_POLICY.concurrency,
  recycleContextEvery: 200, // recyclage mémoire du contexte navigateur
  includeSellerData: true,
  fetchTimeoutMs: 15000,    // timeout d'un fetch in-page (description)
};

// Nombre maximum de pages de recherche capturables (borne anti-abus).
const MAX_PAGES = 500;

// Seuil de blocages consécutifs déclenchant l'arrêt préventif de l'enrichissement.
const BLOCK_THRESHOLD = 3;

// États du disjoncteur (circuit breaker) de l'enrichissement.
//   normal  → tout va bien
//   slowed  → ralentissement (erreurs réseau/latence) mais on continue
//   blocked → blocages répétés, arrêt préventif imminent
//   stopped → arrêt effectif de l'enrichissement
const CIRCUIT_STATES = Object.freeze({
  NORMAL: 'normal',
  SLOWED: 'slowed',
  BLOCKED: 'blocked',
  STOPPED: 'stopped',
});

module.exports = {
  SCRAPING_POLICY,
  MAX_CONCURRENCY,
  getScrapingPolicy,
  clampConcurrency,
  SPEED_PRESETS,
  DEFAULT_SPEED,
  getSpeedPreset,
  PIPELINE_DEFAULTS,
  MAX_PAGES,
  BLOCK_THRESHOLD,
  CIRCUIT_STATES,
};
