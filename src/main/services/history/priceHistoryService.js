'use strict';

/**
 * priceHistoryService — FAÇADE de la fonctionnalité « Évolution des prix ».
 *
 * Seul point d'entrée pour le processus principal :
 *   - résout le chemin de la base (dans BASE_OUT_DIR, à côté des jobs/secrets) ;
 *   - ouvre la base à la demande (lazy) et l'encapsule dans le moteur ;
 *   - fournit l'ingestion après un scraping réussi ;
 *   - fournit l'amorçage/migration depuis les jobs DÉJÀ présents (sans relancer
 *     de collecte) ;
 *   - expose des lectures paginées pour l'interface.
 *
 * Ne jamais exposer l'objet base directement au renderer : l'IPC n'appelle que
 * les méthodes de cette façade (pas de SQL arbitraire côté renderer).
 */

const path = require('path');
const fs = require('fs');
const { PriceHistoryDb, isAvailable } = require('./priceHistoryDb');
const { PriceHistoryEngine } = require('./priceHistoryEngine');

let _singleton = null;

/**
 * Chemin de la base historique (surchargeable pour les tests).
 * @returns {string}
 */
function defaultDbPath() {
  // require paresseux : constants.js require('electron'), ce module doit rester
  // importable dans un contexte de test avec stub.
  let base;
  try {
    ({ BASE_OUT_DIR: base } = require('../../config/constants'));
  } catch {
    base = path.join(process.cwd(), 'output');
  }
  return path.join(base, 'price-history.sqlite');
}

class PriceHistoryService {
  /**
   * @param {Object} [opts] { dbPath, thresholds }
   */
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || defaultDbPath();
    this.thresholds = opts.thresholds || null;
    this._db = null;
    this._engine = null;
    this._lastError = null;
  }

  /** Indique si SQLite embarqué est disponible. */
  static isSupported() { return isAvailable(); }

  /**
   * Ouvre (ou réutilise) la base. Renvoie null si le moteur est indisponible —
   * l'appelant DOIT alors dégrader proprement (aucune fonctionnalité historique,
   * mais le reste de Vendra continue de fonctionner).
   * @returns {Object|null} instance PriceHistoryDb
   */
  open() {
    if (this._db) return this._db;
    try {
      this._db = PriceHistoryDb.open(this.dbPath);
      this._lastError = null;
      return this._db;
    } catch (err) {
      this._lastError = err;
      return null;
    }
  }

  get lastError() { return this._lastError; }

  /**
   * Renvoie le moteur (ouvre la base au besoin). Null si indisponible.
   * @returns {PriceHistoryEngine|null}
   */
  engine() {
    if (this._engine) return this._engine;
    const db = this.open();
    if (!db) return null;
    this._engine = new PriceHistoryEngine(db, this.thresholds ? { thresholds: this.thresholds } : {});
    return this._engine;
  }

  isReady() { return !!this.engine(); }

  /**
   * Ingère les annonces d'une collecte. Tolérant : toute erreur est capturée et
   * renvoyée (le scraping ne doit JAMAIS échouer à cause de l'historique).
   * @param {Array<Object>} ads
   * @param {Object} [opts] { sourceJob, observedAt }
   * @returns {{ok:boolean, summary?:Object, error?:string}}
   */
  ingest(ads, opts = {}) {
    try {
      const engine = this.engine();
      if (!engine) return { ok: false, error: this._lastError ? this._lastError.message : 'SQLite indisponible.' };
      const summary = engine.ingestAds(ads, opts);
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Amorce la base depuis les jobs déjà présents sur le disque (migration).
   * Chaque annonce est datée par la date RÉELLE du job (jamais inventée). Les
   * données importées sont des observations réellement datées (date du job).
   *
   * Idempotent : relancer n'ajoute pas de doublons (upsert + déduplication des
   * observations identiques).
   *
   * @param {Array<Object>} jobs résultat de JobHistoryManager.listAllJobs()
   * @returns {{ok:boolean, jobs:number, ads:number, summary:Object, error?:string}}
   */
  bootstrapFromJobs(jobs) {
    try {
      const engine = this.engine();
      if (!engine) return { ok: false, error: this._lastError ? this._lastError.message : 'SQLite indisponible.' };
      const list = Array.isArray(jobs) ? jobs : [];
      const agg = { processed: 0, created: 0, updated: 0, linked: 0, pending: 0, rejected: 0, errors: 0, pricesExcluded: 0 };
      let jobCount = 0;
      let importedWithoutDate = 0;
      for (const job of list) {
        if (!job || !Array.isArray(job.ads) || job.ads.length === 0) continue;
        // Date RÉELLE du job si son identifiant la porte ; sinon null → le moteur
        // marquera l'observation comme IMPORTÉE (jamais présentée comme une date
        // de collecte). On ne fabrique JAMAIS une date historique.
        const observedAt = jobIsoFromId(job.id);
        if (!observedAt) importedWithoutDate++;
        const res = engine.ingestAds(job.ads, { sourceJob: job.id, observedAt, origin: 'imported' });
        for (const k of Object.keys(agg)) agg[k] += (res[k] || 0);
        jobCount++;
      }
      return { ok: true, jobs: jobCount, ads: agg.processed, summary: agg, importedWithoutDate };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Lectures pour l'interface ─────────────────────────────────────────────

  listProducts(opts) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err(), products: [] };
    return { ok: true, products: engine.listProductSummaries(opts) };
  }

  getProductDetail(productId, opts) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err() };
    const detail = engine.getProductDetail(productId, opts);
    if (!detail) return { ok: false, error: 'Produit introuvable.' };
    return { ok: true, ...detail };
  }

  getProductSeries(productId, opts) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err() };
    const series = engine.getProductSeries(productId, opts);
    if (!series) return { ok: false, error: 'Produit introuvable.' };
    return { ok: true, ...series };
  }

  listPending(opts) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err(), pending: [] };
    return { ok: true, pending: engine.listPending(opts) };
  }

  stats() {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err(), counts: null };
    const db = this._db;
    return {
      ok: true,
      counts: {
        ads: db.countAds(),
        products: db.countProducts(),
        observations: db.countObservations(),
        pending: db.countPendingLinks(),
      },
      families: db.listFamilies(),
    };
  }

  /**
   * Amorçage depuis les jobs déjà présents. Appelé à l'ouverture de l'onglet :
   * l'utilisateur n'a PAS à relancer une collecte pour alimenter l'historique.
   * Idempotent : relancer ne crée pas de doublons.
   * @param {Function} [listJobs] fournisseur de jobs (par défaut JobHistoryManager)
   */
  bootstrapFromExistingJobs(listJobs) {
    try {
      let jobs = null;
      if (typeof listJobs === 'function') {
        jobs = listJobs();
      } else {
        const { JobHistoryManager } = require('../jobs/jobHistory');
        jobs = JobHistoryManager.listAllJobs();
      }
      return this.bootstrapFromJobs(jobs);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  correct(adId, action, opts) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err() };
    return engine.correctAssociation(adId, action, opts);
  }

  recompute(productId) {
    const engine = this.engine();
    if (!engine) return { ok: false, error: this._err() };
    return engine.recomputeStats(productId);
  }

  close() {
    if (this._db) { this._db.close(); this._db = null; this._engine = null; }
  }

  _err() { return this._lastError ? this._lastError.message : 'Base historique indisponible.'; }
}

/**
 * Déduit un horodatage ISO d'un identifiant de job `job-<ISO compacté>`.
 * Renvoie null si non déductible (on n'invente JAMAIS de date).
 * @param {string} jobId
 * @returns {string|null}
 */
function jobIsoFromId(jobId) {
  const m = String(jobId || '').match(/^job-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Renvoie (et mémorise) l'instance partagée de la façade.
 * @param {Object} [opts]
 * @returns {PriceHistoryService}
 */
function getService(opts) {
  if (!_singleton) _singleton = new PriceHistoryService(opts);
  return _singleton;
}

/** Réinitialise le singleton (tests). */
function resetService() { if (_singleton) _singleton.close(); _singleton = null; }

module.exports = { PriceHistoryService, getService, resetService, defaultDbPath, jobIsoFromId };
