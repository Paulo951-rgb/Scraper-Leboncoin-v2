'use strict';

/**
 * priceHistoryEngine — ORCHESTRATION de la fonctionnalité « Évolution des prix ».
 *
 * Ce module relie les couches :
 *   A) Collecte    : reçoit les annonces déjà collectées (jamais de scraping ici).
 *   B) Normalisation/identification : featureExtractor + productIdentity.
 *   C) Persistance : priceHistoryDb.
 *   D) Statistiques : priceStats.
 *
 * Il ne contient AUCUNE logique d'interface et AUCUN accès réseau. Toutes les
 * écritures sont transactionnelles ; une erreur d'identification d'UNE annonce
 * n'interrompt jamais le traitement des autres (isolation par annonce).
 *
 * RÈGLES ABSOLUES respectées :
 *   - jamais d'invention de données (un champ absent reste null) ;
 *   - une annonce n'est jamais dupliquée (identifiant source prioritaire) ;
 *   - une correction manuelle n'est JAMAIS écrasée par le moteur automatique ;
 *   - une absence lors d'une collecte n'est pas une preuve de vente ;
 *   - l'ingestion est idempotente (relancer ne crée pas de doublons).
 */

const crypto = require('crypto');
const { extractFeatures } = require('./featureExtractor');
const { decide, DEFAULT_THRESHOLDS } = require('./productIdentity');
const { analyzePrice } = require('./priceRules');
const { buildCanonicalKey, productFromFeatures, rowToProduct, generateCandidates, buildIndex } = require('./productRegistry');
const { buildProductStats } = require('./priceStats');
const { normalizeReference } = require('./normalizeText');

const ALGORITHM_VERSION = 1;

/**
 * Moteur d'historique des prix. Encapsule une base ouverte.
 */
class PriceHistoryEngine {
  /**
   * @param {Object} db instance PriceHistoryDb (déjà ouverte/migrée)
   * @param {Object} [opts] { thresholds, algorithmVersion }
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('PriceHistoryEngine: base de données requise.');
    this.db = db;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
    this.algorithmVersion = opts.algorithmVersion || ALGORITHM_VERSION;
  }

  /**
   * Ingère un lot d'annonces (déjà normalisées par le pipeline).
   * @param {Array<Object>} ads annonces du modèle Vendra
   * @param {Object} [opts] { sourceJob, observedAt }
   * @returns {{processed:number, created:number, updated:number, linked:number,
   *            pending:number, rejected:number, errors:number, pricesExcluded:number}}
   */
  ingestAds(ads, opts = {}) {
    const list = Array.isArray(ads) ? ads : [];
    // `opts.observedAt` peut être null (job sans date exploitable) : on retombe
    // sur la date de première vue, en marquant l'observation comme IMPORTÉE —
    // elle n'est alors jamais présentée comme une date de collecte réelle.
    const requestedAt = opts.observedAt || null;
    const fallbackAt = new Date().toISOString();
    const observedAt = requestedAt || fallbackAt;
    // `origin` : 'live' pour une collecte réelle, 'imported' pour une migration
    // depuis un job antérieur. Une observation sans date exploitable est
    // TOUJOURS 'imported' (sa date est celle de première vue, pas de collecte).
    const origin = (opts.origin === 'imported' || !requestedAt) ? 'imported' : 'live';
    const sourceJob = opts.sourceJob || null;

    const summary = { processed: 0, created: 0, updated: 0, linked: 0, pending: 0, rejected: 0, errors: 0, pricesExcluded: 0 };
    // Index de candidats construit UNE SEULE FOIS pour le lot, puis maintenu à
    // jour lors des créations de produits. Sans cela, chaque annonce relisait et
    // reconstruisait l'index complet (coût O(N×M) : ~17 s pour 10 000 annonces
    // et 300 modèles). L'index est un objet partagé du lot.
    const index = buildIndex(this.db.listProducts({ limit: 50000 }));
    // L'ingestion est transactionnelle : soit tout le lot est persisté, soit
    // rien (pas d'état partiel en cas d'arrêt inattendu). Chaque annonce est
    // toutefois isolée : une annonce invalide n'annule pas le lot.
    this.db.transaction(() => {
      for (const ad of list) {
        try {
          const res = this._ingestOne(ad, observedAt, sourceJob, index, origin);
          summary.processed++;
          if (res.created) summary.created++; else summary.updated++;
          if (res.decision === 'confirmed') summary.linked++;
          else if (res.decision === 'rejected') summary.rejected++;
          else summary.pending++;
          if (res.priceExcluded) summary.pricesExcluded++;
        } catch (err) {
          // Isolation : une annonce en erreur ne casse pas le lot. On compte et
          // on continue (les autres annonces restent ingérées).
          summary.errors++;
        }
      }
    });
    // Les agrégats mis en cache ne sont plus valides après ingestion.
    this.db.invalidateStatsCache(null);
    return summary;
  }

  /**
   * Ingère UNE annonce. Renvoie l'action effectuée.
   * @private
   */
  _ingestOne(ad, observedAt, sourceJob, index, origin = 'live') {
    if (!ad || typeof ad !== 'object') throw new Error('annonce invalide');
    const sourceId = ad.id != null ? String(ad.id) : null;
    const url = ad.url || null;
    // Sans identifiant ni URL, l'annonce n'est pas indexable de façon fiable :
    // on la refuse plutôt que de risquer un doublon (stratégie de repli
    // documentée : on n'utilise PAS le titre comme clé, trop instable).
    if (!sourceId && !url) throw new Error('annonce sans identifiant ni URL');

    const features = extractFeatures(ad);
    const priceInfo = analyzePrice(ad.prix ?? ad.price, { currency: ad.devise });

    const existing = sourceId ? this.db.getAdBySourceId(sourceId) : null;
    const created = !existing;

    const adId = this.db.upsertAd({
      sourceId,
      url,
      title: ad.title || null,
      description: typeof ad.description === 'string' ? ad.description : null,
      currency: priceInfo.currency,
      condition: features.condition,
      offerType: features.offerType,
      family: features.family,
      brand: features.brand,
      reference: features.primaryReference,
      features,
    }, observedAt);

    // ─── Observation (déduplication) ───────────────────────────────────────
    // On n'enregistre une nouvelle observation QUE si un champ pertinent a
    // changé depuis la dernière (prix, état, type d'offre, validité). Cela
    // évite de créer un enregistrement identique à chaque relance tout en
    // conservant TOUTE évolution de prix.
    const lastObs = this.db.getLastObservation(adId);
    const changed = !lastObs
      || lastObs.price !== (priceInfo.value ?? null)
      || lastObs.condition !== (features.condition ?? null)
      || lastObs.offer_type !== (features.offerType ?? null)
      || (lastObs.price_valid === 0) !== (priceInfo.valid === false);
    if (changed) {
      this.db.insertObservation({
        adId,
        observedAt,
        price: priceInfo.value,
        currency: priceInfo.currency,
        condition: features.condition,
        offerType: features.offerType,
        availability: 'observed',
        sourceJob,
        features,
        priceValid: priceInfo.valid,
        priceReason: priceInfo.reason,
        flags: priceInfo.flags,
        origin,
      });
    } else {
      // Aucun changement : on met simplement à jour la date de dernière vue.
      this.db.touchAd(adId, observedAt, 'observed');
    }
    if (Number.isFinite(priceInfo.value)) this.db.setAdLatestPrice(adId, priceInfo.value, observedAt);
    this.db.setAdQuality(adId, { priceReason: priceInfo.reason, priceFlags: priceInfo.flags, features: {
      brand: features.brand, family: features.family, reference: features.primaryReference,
      condition: features.condition, offerType: features.offerType, hasDescription: features.hasDescription,
    } });

    // ─── Association produit ───────────────────────────────────────────────
    // Une association MANUELLE existante n'est jamais écrasée par le moteur.
    const existingLink = this.db.getLink(adId);
    if (existingLink && existingLink.link_status === 'manual') {
      return { created, decision: existingLink.decision, priceExcluded: !priceInfo.valid };
    }

    const decision = this._decideAndLink(adId, features, observedAt, index);
    return { created, decision: decision.decision, priceExcluded: !priceInfo.valid };
  }

  /**
   * Décide du rapprochement d'une annonce et persiste le lien.
   * @param {Object} [index] index de candidats partagé du lot (reconstruit si absent)
   * @private
   */
  _decideAndLink(adId, features, nowIso, index) {
    const idx = index || buildIndex(this.db.listProducts({ limit: 50000 }));
    const candidates = generateCandidates(features, idx, 12);
    const result = decide(features, candidates, this.thresholds);

    let productId = null;
    let linkStatus = 'pending';
    if (result.recommendation === 'link') {
      productId = this._resolveOrCreateProduct(features, result.product, nowIso);
      linkStatus = 'auto';
    } else if (result.recommendation === 'new') {
      // Identité inédite portée par une référence utilisable : on crée un
      // produit PROVISOIRE et on associe. Un nouveau modèle n'attend pas de
      // mise à jour logicielle pour être suivi.
      productId = this._createProduct(features, nowIso, 'provisional', 'observed');
      linkStatus = 'auto';
      result.decision = 'confirmed';
    } else if (result.recommendation === 'reject') {
      linkStatus = 'rejected';
      productId = null;
    } else {
      linkStatus = 'pending';
      productId = result.product && result.product.id ? result.product.id : null;
    }

    // Maintient l'index partagé : un produit nouvellement créé/confirmé doit
    // être candidat pour les annonces SUIVANTES du même lot (sinon chaque
    // annonce d'un modèle inédit créerait un produit distinct).
    if (productId && index) this._addToIndex(index, productId);

    this.db.upsertLink({
      adId,
      productId,
      decision: result.decision,
      linkStatus,
      score: result.score,
      reasons: result.evaluation ? result.evaluation.reasons : null,
      contradictions: result.evaluation ? result.evaluation.contradictions : [],
      candidates: result.candidates,
      algorithmVersion: this.algorithmVersion,
      decidedAt: nowIso,
    });

    // Alias observé : mémorisé pour un produit associé (linkStatus auto/manual)
    // uniquement. Une simple cooccurrence incertaine ne crée PAS d'alias.
    if (productId && linkStatus === 'auto' && features.primaryReference) {
      const normalized = normalizeReference(features.primaryReference);
      this.db.addAlias(productId, features.primaryReference, normalized, 'observed', 0.6, nowIso);
    }

    return { decision: result.decision, productId, result };
  }

  /**
   * Crée un produit (provisoire ou confirmé) à partir des caractéristiques.
   * @private
   */
  _createProduct(features, nowIso, status = 'provisional', provenance = 'observed') {
    const key = buildCanonicalKey(features);
    const existing = this.db.getProductByKey(key);
    if (existing) {
      if (status === 'confirmed' && existing.status === 'provisional') {
        this.db.updateProduct(existing.id, { status: 'confirmed' }, nowIso);
      }
      return existing.id;
    }
    const product = productFromFeatures(features);
    product.status = status;
    product.provenance = provenance;
    return this.db.insertProduct(product, nowIso);
  }

  /**
   * Retrouve un produit par sa clé canonique ou le crée (PROVISOIRE).
   * @private
   */
  _resolveOrCreateProduct(features, candidate, nowIso) {
    if (candidate && candidate.id) {
      // Le produit candidat existe déjà : on peut confirmer son statut.
      if (candidate.status === 'provisional') {
        this.db.updateProduct(candidate.id, { status: 'confirmed' }, nowIso);
      }
      return candidate.id;
    }
    return this._createProduct(features, nowIso, 'provisional', 'observed');
  }

  // ─── Lecture / statistiques ────────────────────────────────────────────────

  /**
   * Liste paginée des produits avec un résumé de statistiques (pour l'onglet).
   * @param {Object} [opts] { limit, offset, family, q, periodDays }
   * @returns {Array<Object>}
   */
  listProductSummaries(opts = {}) {
    const limit = Math.min(500, Math.max(1, opts.limit || 50));
    const offset = Math.max(0, opts.offset || 0);
    const rows = this.db.listProducts({ limit, offset, family: opts.family || null, q: opts.q || null });
    return rows.map((row) => {
      const product = rowToProduct(row);
      const observations = this._observationsForProduct(product.id);
      const stats = buildProductStats(observations, { granularity: opts.granularity || 'day', nowIso: opts.nowIso });
      return {
        id: product.id,
        label: product.label,
        reference: product.reference,
        brand: product.brand,
        family: product.family,
        status: product.status,
        distinctAds: stats.distinctAds,
        lastObservedAt: stats.lastObservedAt,
        median: stats.overall.median,
        mean: stats.overall.mean,
        min: stats.overall.min,
        max: stats.overall.max,
        evolution: stats.evolution,
        quality: stats.quality,
      };
    });
  }

  /**
   * Fiche complète d'un produit (statistiques + annonces incluses/exclues).
   * @param {number} productId
   * @param {Object} [opts]
   */
  getProductDetail(productId, opts = {}) {
    const row = this.db.getProduct(productId);
    if (!row) return null;
    const product = rowToProduct(row);
    const aliases = this.db.listAliases(productId).map((a) => ({ alias: a.alias, source: a.source, confidence: a.confidence }));

    const links = this.db.listLinksByProduct(productId, { statuses: ['auto', 'manual'] });
    const adIds = links.map((l) => l.ad_id);
    const observations = this._observationsForAdIds(adIds);
    const stats = buildProductStats(observations, {
      granularity: opts.granularity || 'day',
      nowIso: opts.nowIso,
      identifiedCount: links.length,
      totalLinkedAds: links.length,
    });

    // Annonces incluses (auto/manual) avec leur dernière observation.
    const includedAds = [];
    for (const l of links) {
      const ad = this.db.getAd(l.ad_id);
      if (!ad) continue;
      const last = this.db.getLastObservation(l.ad_id);
      includedAds.push({
        id: ad.id,
        sourceId: ad.source_id,
        title: ad.title,
        url: ad.url,
        price: last ? last.price : null,
        currency: last ? last.currency : ad.currency,
        condition: ad.condition,
        offerType: ad.offer_type,
        firstSeen: ad.first_seen,
        lastSeen: ad.last_seen,
        linkStatus: l.link_status,
        score: l.score,
      });
    }

    // Annonces EXCLUES du produit : liées mais rejetées (avec motif).
    const excludedLinks = this.db.listLinksByProduct(productId, { statuses: ['rejected'] });
    const excludedAds = excludedLinks.map((l) => {
      const ad = this.db.getAd(l.ad_id);
      let contradictions = [];
      try { contradictions = l.contradictions_json ? JSON.parse(l.contradictions_json) : []; } catch { contradictions = []; }
      return {
        id: l.ad_id,
        title: ad ? ad.title : null,
        url: ad ? ad.url : null,
        score: l.score,
        reasons: contradictions.map((c) => c.type),
      };
    });

    return {
      product: {
        id: product.id, label: product.label, reference: product.reference,
        brand: product.brand, family: product.family, status: product.status,
        units: product.units,
      },
      aliases,
      stats,
      includedAds,
      excludedAds,
      pendingCount: this.db.countPendingLinks(),
    };
  }

  /** Série temporelle d'un produit pour une période donnée (jours). */
  getProductSeries(productId, opts = {}) {
    const row = this.db.getProduct(productId);
    if (!row) return null;
    const links = this.db.listLinksByProduct(productId, { statuses: ['auto', 'manual'] });
    const observations = this._observationsForAdIds(links.map((l) => l.ad_id));
    const filtered = this._filterByWindow(observations, opts.days, opts.nowIso);
    return buildProductStats(filtered, { granularity: opts.granularity || 'day', nowIso: opts.nowIso });
  }

  /** File des rapprochements incertains (annonces à examiner). */
  listPending(opts = {}) {
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const offset = Math.max(0, opts.offset || 0);
    const rows = this.db.listPendingLinks({ limit, offset });
    return rows.map((r) => {
      let candidates = [];
      let contradictions = [];
      try { candidates = r.candidates_json ? JSON.parse(r.candidates_json) : []; } catch { candidates = []; }
      try { contradictions = r.contradictions_json ? JSON.parse(r.contradictions_json) : []; } catch { contradictions = []; }
      const ad = this.db.getAd(r.ad_id);
      return {
        adId: r.ad_id,
        title: r.ad_title,
        url: r.ad_url,
        reference: r.ad_reference,
        family: r.ad_family,
        description: ad ? (ad.description || '').slice(0, 600) : '',
        decision: r.decision,
        linkStatus: r.link_status,
        score: r.score,
        candidates,
        contradictions,
        decidedAt: r.decided_at,
      };
    });
  }

  countPending() { return this.db.countPendingLinks(); }

  // ─── Corrections manuelles ─────────────────────────────────────────────────

  /**
   * Corrige manuellement l'association d'une annonce.
   * @param {number} adId
   * @param {Object} action { type:'confirm'|'reject'|'move'|'create', productId?, label? }
   * @param {Object} [opts] { nowIso, note }
   * @returns {{ok:boolean, productId?:number, error?:string}}
   */
  correctAssociation(adId, action, opts = {}) {
    const nowIso = opts.nowIso || new Date().toISOString();
    const ad = this.db.getAd(adId);
    if (!ad) return { ok: false, error: 'Annonce introuvable.' };
    const act = action && action.type;
    const previousLink = this.db.getLink(adId);

    return this.db.transaction(() => {
      let productId = null;
      let decision = 'uncertain';
      let linkStatus = 'manual';

      if (act === 'confirm') {
        productId = action.productId || (previousLink && previousLink.product_id) || null;
        if (!productId) {
          // Confirmer sans produit cible : on crée une identité provisoire à
          // partir des caractéristiques de l'annonce (validée par l'utilisateur).
          const features = this._featuresOfAd(ad);
          const key = buildCanonicalKey(features);
          const existing = this.db.getProductByKey(key);
          productId = existing ? existing.id : this.db.insertProduct({ ...productFromFeatures(features), status: 'confirmed', provenance: 'manual' }, nowIso);
        }
        decision = 'confirmed';
      } else if (act === 'reject') {
        productId = null;
        decision = 'rejected';
      } else if (act === 'move') {
        productId = action.productId || null;
        decision = 'confirmed';
      } else if (act === 'create') {
        // Créer une identité provisoire explicitement demandée par l'utilisateur.
        const features = this._featuresOfAd(ad);
        const key = buildCanonicalKey(features);
        const existing = this.db.getProductByKey(key);
        productId = existing ? existing.id : this.db.insertProduct({ ...productFromFeatures(features), status: 'provisional', provenance: 'manual' }, nowIso);
        decision = 'confirmed';
      } else {
        return { ok: false, error: `Action inconnue : ${act}` };
      }

      this.db.upsertLink({
        adId,
        productId,
        decision,
        linkStatus,
        score: previousLink ? previousLink.score : null,
        reasons: { manual: true },
        contradictions: [],
        candidates: [],
        algorithmVersion: this.algorithmVersion,
        decidedAt: nowIso,
      });
      this.db.addCorrection({
        adId,
        action: act,
        fromProductId: previousLink ? previousLink.product_id : null,
        toProductId: productId,
        note: opts.note || null,
        createdAt: nowIso,
      });
      // Un alias validé manuellement est conservé et fait foi.
      if (productId) {
        const features = this._featuresOfAd(ad);
        if (features.primaryReference) {
          this.db.addAlias(productId, features.primaryReference, normalizeReference(features.primaryReference), 'manual', 1.0, nowIso);
        }
      }
      // Les agrégats des produits concernés sont invalidés (recalcul au besoin).
      this.db.invalidateStatsCache(productId);
      if (previousLink && previousLink.product_id) this.db.invalidateStatsCache(previousLink.product_id);
      return { ok: true, productId };
    });
  }

  /** Recalcule les statistiques d'un produit (ou de tous) et met le cache à jour. */
  recomputeStats(productId = null, opts = {}) {
    const nowIso = opts.nowIso || new Date().toISOString();
    if (productId != null) {
      const detail = this.getProductDetail(productId, { nowIso });
      if (!detail) return { ok: false, error: 'Produit introuvable.' };
      this.db.putStatsCache(`product:${productId}:all`, productId, detail.stats, ALGORITHM_VERSION, nowIso);
      return { ok: true, stats: detail.stats };
    }
    const products = this.db.listProducts({ limit: 10000 });
    for (const row of products) {
      const detail = this.getProductDetail(row.id, { nowIso });
      if (detail) this.db.putStatsCache(`product:${row.id}:all`, row.id, detail.stats, ALGORITHM_VERSION, nowIso);
    }
    return { ok: true, count: products.length };
  }

  // ─── Helpers internes ──────────────────────────────────────────────────────

  /**
   * Ajoute un produit à l'index partagé (sans écraser une entrée existante).
   * @private
   */
  _addToIndex(index, productId) {
    const row = this.db.getProduct(productId);
    if (!row) return;
    const product = rowToProduct(row);
    if (!product) return;
    if (!index.all.some((p) => p.id === product.id)) index.all.push(product);
    const ref = normalizeReference(product.reference);
    if (ref) {
      if (!index.byReference.has(ref)) index.byReference.set(ref, []);
      if (!index.byReference.get(ref).some((p) => p.id === product.id)) index.byReference.get(ref).push(product);
    }
    if (product.family) {
      if (!index.byFamily.has(product.family)) index.byFamily.set(product.family, []);
      if (!index.byFamily.get(product.family).some((p) => p.id === product.id)) index.byFamily.get(product.family).push(product);
    }
  }

  _featuresOfAd(adRow) {
    if (adRow.features_json) {
      try { return JSON.parse(adRow.features_json); } catch { /* repli */ }
    }
    return extractFeatures({ title: adRow.title, description: adRow.description, etat: adRow.condition });
  }

  _observationsForAdIds(adIds) {
    const out = [];
    for (const id of adIds) {
      for (const o of this.db.listObservations(id)) {
        out.push({
          adId: o.ad_id,
          observedAt: o.observed_at,
          price: o.price,
          currency: o.currency,
          condition: o.condition,
          offerType: o.offer_type,
          priceValid: o.price_valid !== 0,
          priceReason: o.price_reason,
          sourceJob: o.source_job,
        });
      }
    }
    return out;
  }

  _observationsForProduct(productId) {
    const links = this.db.listLinksByProduct(productId, { statuses: ['auto', 'manual'] });
    return this._observationsForAdIds(links.map((l) => l.ad_id));
  }

  _filterByWindow(observations, days, nowIso) {
    if (!days || days <= 0) return observations;
    const now = new Date(nowIso || Date.now()).getTime();
    const cutoff = now - days * 86400000;
    return observations.filter((o) => {
      const t = new Date(o.observedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }
}

module.exports = { PriceHistoryEngine, ALGORITHM_VERSION };
