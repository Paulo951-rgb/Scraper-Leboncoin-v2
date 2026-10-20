'use strict';

/**
 * Constantes partagées du scraping — SOURCE UNIQUE DE VÉRITÉ de la politique de
 * débit.
 *
 * Ce module ne requiert PAS `electron` : il est importable aussi bien par le
 * main process que par le pipeline forké (sous-processus sans accès à `app`).
 * Il centralise les seuils/délais/presets auparavant dispersés entre
 * `leboncoin-pipeline.js`, `ipcHandlers.js` et `harCapturer.js`, afin d'éviter
 * les désynchronisations (une valeur modifiée d'un côté seulement).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * POURQUOI CES VALEURS (robustesse > débit maximal)
 * ───────────────────────────────────────────────────────────────────────────
 * Un réglage « ultra-rapide par défaut » (concurrence 25, délai de page 400 ms)
 * déclenche très vite la classification robot de Leboncoin / CloudFront (403,
 * page « Accès temporairement restreint »). On rétablit un mode « moyen »
 * PAR DÉFAUT, prudent, tout en laissant l'utilisateur choisir un mode plus rapide
 * (au prix d'un risque de blocage plus élevé, clairement signalé dans l'UI).
 *
 * Bornes ABSOLUES (jamais franchies, même par un preset ou un renderer compromis) :
 *   - concurrence ≤ MAX_CONCURRENCY (20) ;
 *   - délai nominal entre pages ≥ MIN_PAGE_DELAY_MS (450 ms).
 * ───────────────────────────────────────────────────────────────────────────
 */

// Presets de vitesse. Chaque preset fixe la concurrence, les délais de page de
// recherche (min/max, jitter) et les délais d'enrichissement des descriptions.
//
//   concurrency        : nombre MAXIMAL de tâches parallèles (jamais dépassé).
//   minPageDelayMs     : délai MINIMAL entre deux pages de recherche.
//   maxPageDelayMs     : délai MAXIMAL entre deux pages de recherche (jitter).
//   enrichMinDelayMs   : délai de BASE de l'enrichissement (sert aussi de
//                        PLANCHER de backoff : un baseDelay trop faible rendrait
//                        le backoff après blocage minuscule, donc inefficace).
//   enrichMaxDelayMs   : délai maximal du limiteur adaptatif (hors blocage).
const SPEED_PRESETS = Object.freeze({
  moyen: Object.freeze({
    label: 'MOYEN',
    concurrency: 10,
    minPageDelayMs: 900,
    maxPageDelayMs: 1600,
    enrichMinDelayMs: 600,
    enrichMaxDelayMs: 3000,
  }),
  rapide: Object.freeze({
    label: 'RAPIDE',
    concurrency: 15,
    minPageDelayMs: 600,
    maxPageDelayMs: 1200,
    enrichMinDelayMs: 400,
    enrichMaxDelayMs: 2000,
  }),
  'ultra-rapide': Object.freeze({
    label: 'ULTRA RAPIDE',
    concurrency: 20,
    minPageDelayMs: 450,
    maxPageDelayMs: 900,
    enrichMinDelayMs: 300,
    enrichMaxDelayMs: 1500,
  }),
});

// Mode par défaut : « moyen » (prudent). L'utilisateur peut choisir plus rapide,
// jamais plus agressif que « ultra-rapide ».
const DEFAULT_SPEED = 'moyen';
const SPEED_MODES = Object.freeze(Object.keys(SPEED_PRESETS));

// Bornes ABSOLUES de sécurité (invariants garantis par les tests).
const MAX_CONCURRENCY = 20;      // jamais 25 : trop de parallélisme = blocage
const MIN_PAGE_DELAY_MS = 450;   // jamais sous 450 ms, même en ultra-rapide

// Politique de backoff (ralentissement après un refus d'accès).
const BACKOFF = Object.freeze({
  // Plafond du backoff de l'ENRICHISSEMENT après blocage (403/429) : le limiteur
  // monte base × 2^N jusqu'à ce plafond — assez haut pour freiner réellement une
  // rafale de blocages, sans pause démesurée.
  enrichMaxMs: 45000,
  // Backoff de PAGE en capture après un refus HTTP transitoire (403/429 nu) :
  // premier palier « plusieurs secondes », puis doublement exponentiel.
  pageBaseMs: 3000,
  pageMaxMs: 30000,
});

/**
 * Normalise un mode de vitesse demandé vers un mode connu (repli sur le défaut).
 * Un mode inconnu (ancien réglage, valeur corrompue) ne peut donc PAS relever le
 * débit : il retombe sur « moyen ».
 * @param {*} speed
 * @returns {string}
 */
function normalizeSpeed(speed) {
  return SPEED_MODES.includes(speed) ? speed : DEFAULT_SPEED;
}

/**
 * Renvoie une copie du preset de vitesse (bornes appliquées), pour un mode donné.
 * Conserve la forme historique { concurrency, minDelayMs, maxDelayMs, mode } en
 * plus des champs de page/enrichissement explicites.
 * @param {string} [speed]
 * @returns {{concurrency:number,minDelayMs:number,maxDelayMs:number,minPageDelayMs:number,maxPageDelayMs:number,label:string,mode:string}}
 */
function getSpeedPreset(speed) {
  const mode = normalizeSpeed(speed);
  const p = SPEED_PRESETS[mode];
  return {
    concurrency: Math.min(p.concurrency, MAX_CONCURRENCY),
    // Alias historiques : minDelayMs/maxDelayMs désignaient l'enrichissement.
    minDelayMs: p.enrichMinDelayMs,
    maxDelayMs: p.enrichMaxDelayMs,
    minPageDelayMs: Math.max(p.minPageDelayMs, MIN_PAGE_DELAY_MS),
    maxPageDelayMs: Math.max(p.maxPageDelayMs, MIN_PAGE_DELAY_MS),
    label: p.label,
    mode,
  };
}

/**
 * Politique de scraping ACTIVE, validée et bornée, pour un mode de vitesse.
 * La concurrence ne dépasse JAMAIS MAX_CONCURRENCY et le délai de page jamais
 * MIN_PAGE_DELAY_MS, quel que soit le mode demandé.
 * @param {string} [speed] mode demandé (défaut : moyen)
 * @returns {{mode:string,label:string,concurrency:number,pageDelayMs:number,minPageDelayMs:number,maxPageDelayMs:number,enrichMinDelayMs:number,enrichMaxDelayMs:number}}
 */
function getScrapingPolicy(speed) {
  const mode = normalizeSpeed(speed);
  const p = SPEED_PRESETS[mode];
  const minPageDelayMs = Math.max(p.minPageDelayMs, MIN_PAGE_DELAY_MS);
  const maxPageDelayMs = Math.max(p.maxPageDelayMs, minPageDelayMs);
  return {
    mode,
    label: p.label,
    concurrency: Math.min(p.concurrency, MAX_CONCURRENCY),
    // Délai nominal (compatibilité) = borne basse de la plage de jitter.
    pageDelayMs: minPageDelayMs,
    minPageDelayMs,
    maxPageDelayMs,
    enrichMinDelayMs: p.enrichMinDelayMs,
    enrichMaxDelayMs: p.enrichMaxDelayMs,
  };
}

// Politique par DÉFAUT (mode « moyen »), figée : sert de repli sûr partout où un
// appelant ne précise pas de mode (harCapturer par défaut, pipeline sans --speed).
const SCRAPING_POLICY = Object.freeze(getScrapingPolicy(DEFAULT_SPEED));

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

// Valeurs par défaut du pipeline. La concurrence et les délais effectifs
// proviennent de la politique active (getScrapingPolicy) ; ces valeurs ne servent
// que de repli si le pipeline est utilisé en bibliothèque sans configuration.
const PIPELINE_DEFAULTS = {
  minDelayMs: SCRAPING_POLICY.enrichMinDelayMs,
  maxDelayMs: SCRAPING_POLICY.enrichMaxDelayMs,
  blockBackoffMaxMs: BACKOFF.enrichMaxMs,
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
  SPEED_PRESETS,
  SPEED_MODES,
  DEFAULT_SPEED,
  MAX_CONCURRENCY,
  MIN_PAGE_DELAY_MS,
  BACKOFF,
  SCRAPING_POLICY,
  normalizeSpeed,
  getScrapingPolicy,
  getSpeedPreset,
  clampConcurrency,
  PIPELINE_DEFAULTS,
  MAX_PAGES,
  BLOCK_THRESHOLD,
  CIRCUIT_STATES,
};
