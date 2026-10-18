'use strict';

/**
 * priceHistoryDb — couche de PERSISTANCE historique (SQLite).
 *
 * Choix technique : `node:sqlite` (DatabaseSync), disponible nativement dans le
 * Node.js embarqué par Electron 44 (Node 24). Aucune dépendance externe
 * (pas de better-sqlite3 → pas de module natif à recompiler, ce qui préserve la
 * fiabilité du build Windows : `npmRebuild:false` reste valable).
 *
 * Le module est VOLONTAIREMENT isolé de `electron` : il est importable par les
 * tests et par le pipeline forké. Le chemin de la base est fourni par l'appelant.
 *
 * Responsabilités :
 *   - ouvrir/fermer la base (avec PRAGMA de robustesse) ;
 *   - appliquer des MIGRATIONS versionnées et idempotentes ;
 *   - fournir des accès CRUD transactionnels (annonces, produits, liens,
 *     observations, alias, corrections manuelles) ;
 *   - ne JAMAIS construire de SQL par concaténation de valeurs (requêtes
 *     préparées uniquement).
 *
 * Le module ne calcule AUCUNE statistique et ne prend AUCUNE décision
 * d'identité : ces responsabilités appartiennent aux couches supérieures.
 */

const fs = require('fs');
const path = require('path');

let sqlite = null;
let sqliteError = null;
try {
  // Disponible sans drapeau sur Node >= 23.4 / Electron 44 (Node 24).
  sqlite = require('node:sqlite');
} catch (err) {
  sqliteError = err;
}

/**
 * Indique si le moteur SQLite embarqué est disponible dans ce runtime.
 * @returns {boolean}
 */
function isAvailable() {
  return !!sqlite && typeof sqlite.DatabaseSync === 'function';
}

// ─── Migrations ──────────────────────────────────────────────────────────────
// Chaque migration est appliquée UNE fois, dans l'ordre, dans une transaction.
// Les migrations sont IDEMPOTENTES (CREATE ... IF NOT EXISTS, ADD COLUMN gardé).
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ads (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id      TEXT UNIQUE,
          url            TEXT,
          url_hash       TEXT UNIQUE,
          title          TEXT,
          description    TEXT,
          currency       TEXT DEFAULT 'EUR',
          first_seen     TEXT NOT NULL,
          last_seen      TEXT NOT NULL,
          latest_price   REAL,
          latest_price_at TEXT,
          condition      TEXT,
          offer_type     TEXT,
          family         TEXT,
          brand          TEXT,
          reference      TEXT,
          availability   TEXT DEFAULT 'observed',
          features_json  TEXT,
          quality_json   TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_key  TEXT UNIQUE NOT NULL,
          reference      TEXT,
          brand          TEXT,
          family         TEXT,
          label          TEXT,
          units_json     TEXT,
          title_tokens   TEXT,
          status         TEXT NOT NULL DEFAULT 'provisional',
          rules_version  INTEGER NOT NULL DEFAULT 1,
          provenance     TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ad_product_links (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ad_id          INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
          product_id     INTEGER REFERENCES products(id) ON DELETE SET NULL,
          decision       TEXT NOT NULL,
          link_status    TEXT NOT NULL DEFAULT 'auto',
          score          REAL,
          reasons_json   TEXT,
          contradictions_json TEXT,
          candidates_json TEXT,
          algorithm_version INTEGER NOT NULL DEFAULT 1,
          decided_at     TEXT NOT NULL,
          UNIQUE(ad_id)
        );

        CREATE TABLE IF NOT EXISTS observations (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ad_id          INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
          observed_at    TEXT NOT NULL,
          price          REAL,
          currency       TEXT,
          condition      TEXT,
          offer_type     TEXT,
          availability   TEXT,
          source_job     TEXT,
          features_json  TEXT,
          price_valid    INTEGER DEFAULT 1,
          price_reason   TEXT,
          flags_json     TEXT
        );

        CREATE TABLE IF NOT EXISTS aliases (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          alias          TEXT NOT NULL,
          normalized     TEXT NOT NULL,
          source         TEXT NOT NULL DEFAULT 'observed',
          confidence     REAL,
          created_at     TEXT NOT NULL,
          UNIQUE(product_id, normalized)
        );

        CREATE TABLE IF NOT EXISTS ad_corrections (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ad_id          INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
          action         TEXT NOT NULL,
          from_product_id INTEGER,
          to_product_id  INTEGER,
          note           TEXT,
          created_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_aliases_index (
          normalized     TEXT PRIMARY KEY,
          product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          created_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ads_source_id   ON ads(source_id);
        CREATE INDEX IF NOT EXISTS idx_ads_url_hash    ON ads(url_hash);
        CREATE INDEX IF NOT EXISTS idx_ads_reference   ON ads(reference);
        CREATE INDEX IF NOT EXISTS idx_ads_family      ON ads(family);
        CREATE INDEX IF NOT EXISTS idx_ads_last_seen   ON ads(last_seen);
        CREATE INDEX IF NOT EXISTS idx_obs_ad          ON observations(ad_id);
        CREATE INDEX IF NOT EXISTS idx_obs_observed_at ON observations(observed_at);
        CREATE INDEX IF NOT EXISTS idx_obs_ad_price    ON observations(ad_id, price);
        CREATE INDEX IF NOT EXISTS idx_links_product   ON ad_product_links(product_id);
        CREATE INDEX IF NOT EXISTS idx_links_status    ON ad_product_links(link_status);
        CREATE INDEX IF NOT EXISTS idx_products_ref    ON products(reference);
        CREATE INDEX IF NOT EXISTS idx_products_key    ON products(canonical_key);
        CREATE INDEX IF NOT EXISTS idx_alias_norm      ON aliases(normalized);
        CREATE INDEX IF NOT EXISTS idx_alias_index_pid ON product_aliases_index(product_id);
      `);
    },
  },
  {
    version: 2,
    name: 'stats-cache',
    up(db) {
      // Cache d'agrégats : TOUJOURS reconstructible depuis observations/links.
      // `invalidated_at` non nul ⇒ recalcul nécessaire. Aucune donnée de calcul
      // n'est ici l'unique source de vérité (recalculable intégralement).
      db.exec(`
        CREATE TABLE IF NOT EXISTS stats_cache (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          cache_key      TEXT UNIQUE NOT NULL,
          product_id     INTEGER,
          payload_json   TEXT NOT NULL,
          computed_at    TEXT NOT NULL,
          algorithm_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_stats_cache_product ON stats_cache(product_id);
      `);
    },
  },
  {
    version: 3,
    name: 'observation-origin',
    up(db) {
      // `origin` distingue une observation RÉELLEMENT datée (collecte live) d'une
      // observation IMPORTÉE depuis un job antérieur. La date d'import n'est
      // jamais présentée comme une date de collecte : le modèle doit pouvoir
      // séparer « date réelle de première collecte » et « date de migration ».
      db.exec(`ALTER TABLE observations ADD COLUMN origin TEXT DEFAULT 'live';`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_origin ON observations(origin);`);
    },
  },
];

/**
 * Classe d'accès à la base historique. Une instance = une base ouverte.
 */
class PriceHistoryDb {
  /**
   * @param {Object} DatabaseSync instance node:sqlite
   * @param {string} dbPath
   */
  constructor(DatabaseSync, dbPath) {
    this.db = DatabaseSync;
    this.path = dbPath;
    this._closed = false;
  }

  /**
   * Ouvre (ou crée) une base et applique les migrations.
   * @param {string} dbPath chemin du fichier .sqlite
   * @returns {PriceHistoryDb}
   */
  static open(dbPath) {
    if (!isAvailable()) {
      throw new Error(
        'SQLite embarqué (node:sqlite) indisponible dans ce runtime. '
        + (sqliteError ? sqliteError.message : 'module absent')
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = sqlite.DatabaseSync;
    const db = new DatabaseSync(dbPath);
    const instance = new PriceHistoryDb(db, dbPath);
    instance._configure();
    instance._migrate();
    return instance;
  }

  _configure() {
    // Robustesse : WAL pour la concurrence lecture/écriture, clés étrangères
    // activées, attente courte si la base est verrouillée par une autre
    // opération (le pipeline et l'UI peuvent écrire).
    try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch { /* best-effort */ }
    try { this.db.exec('PRAGMA foreign_keys = ON;'); } catch { /* best-effort */ }
    try { this.db.exec('PRAGMA synchronous = NORMAL;'); } catch { /* best-effort */ }
    try { this.db.exec('PRAGMA busy_timeout = 4000;'); } catch { /* best-effort */ }
  }

  _migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT NOT NULL);');
    const applied = new Set(this._all('SELECT version FROM schema_migrations').map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this._transaction(() => {
        m.up(this.db);
        this._run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
      });
    }
  }

  /** Version de schéma appliquée (max). */
  schemaVersion() {
    const rows = this._all('SELECT MAX(version) AS v FROM schema_migrations');
    return rows.length && rows[0].v != null ? rows[0].v : 0;
  }

  // ─── Helpers bas niveau (requêtes préparées uniquement) ────────────────────
  // Les instructions sont MISES EN CACHE : `db.prepare()` recompilait la requête
  // à chaque appel (coût dominant sur une ingestion de masse : 10 000 annonces ×
  // plusieurs requêtes). Le cache est vidé à la fermeture.
  _stmt(sql) {
    if (!this._stmts) this._stmts = new Map();
    let stmt = this._stmts.get(sql);
    if (!stmt) { stmt = this.db.prepare(sql); this._stmts.set(sql, stmt); }
    return stmt;
  }

  _run(sql, params = []) { return this._stmt(sql).run(...params); }
  _get(sql, params = []) { return this._stmt(sql).get(...params); }
  _all(sql, params = []) { return this._stmt(sql).all(...params); }

  _transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Exécute fn dans une transaction (exposé aux couches supérieures). */
  transaction(fn) { return this._transaction(fn); }

  close() {
    if (this._closed) return;
    try { if (this._stmts) { for (const s of this._stmts.values()) { try { s.finalize && s.finalize(); } catch { /* ignore */ } } this._stmts.clear(); } } catch { /* ignore */ }
    try { this.db.close(); } catch { /* ignore */ }
    this._closed = true;
  }

  // ─── Annonces ──────────────────────────────────────────────────────────────

  /**
   * Insère ou retrouve une annonce par identifiant source (préféré) ou par
   * empreinte d'URL (repli). Ne duplique JAMAIS une annonce existante.
   * @param {Object} ad { sourceId, url, title, description, currency, features, condition, offerType, family, brand, reference }
   * @param {string} nowIso
   * @returns {number} id interne de l'annonce
   */
  upsertAd(ad, nowIso) {
    const sourceId = ad.sourceId != null && String(ad.sourceId).trim() !== '' ? String(ad.sourceId) : null;
    const urlHash = ad.url ? require('crypto').createHash('sha256').update(String(ad.url)).digest('hex') : null;

    let existing = null;
    if (sourceId) existing = this._get('SELECT * FROM ads WHERE source_id = ?', [sourceId]);
    if (!existing && urlHash) existing = this._get('SELECT * FROM ads WHERE url_hash = ?', [urlHash]);

    const featuresJson = ad.features ? JSON.stringify(ad.features) : null;

    if (existing) {
      this._run(
        `UPDATE ads SET
           url = COALESCE(?, url),
           title = COALESCE(?, title),
           description = COALESCE(?, description),
           currency = COALESCE(?, currency),
           condition = COALESCE(?, condition),
           offer_type = COALESCE(?, offer_type),
           family = COALESCE(?, family),
           brand = COALESCE(?, brand),
           reference = COALESCE(?, reference),
           features_json = COALESCE(?, features_json),
           last_seen = ?,
           updated_at = ?
         WHERE id = ?`,
        [ad.url || null, ad.title || null, ad.description || null, ad.currency || null,
          ad.condition || null, ad.offerType || null, ad.family || null, ad.brand || null,
          ad.reference || null, featuresJson, nowIso, nowIso, existing.id]
      );
      return existing.id;
    }

    const info = this._run(
      `INSERT INTO ads (source_id, url, url_hash, title, description, currency,
        first_seen, last_seen, condition, offer_type, family, brand, reference,
        availability, features_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?, ?)`,
      [sourceId, ad.url || null, urlHash, ad.title || null, ad.description || null,
        ad.currency || 'EUR', nowIso, nowIso, ad.condition || null, ad.offerType || null,
        ad.family || null, ad.brand || null, ad.reference || null, featuresJson, nowIso, nowIso]
    );
    return Number(info.lastInsertRowid);
  }

  getAd(adId) { return this._get('SELECT * FROM ads WHERE id = ?', [adId]); }
  getAdBySourceId(sourceId) { return this._get('SELECT * FROM ads WHERE source_id = ?', [sourceId]); }

  /**
   * Marque la dernière observation d'une annonce (prix + dispo) sans créer
   * d'observation.
   */
  touchAd(adId, nowIso, availability) {
    if (availability) {
      this._run('UPDATE ads SET last_seen = ?, availability = ?, updated_at = ? WHERE id = ?', [nowIso, availability, nowIso, adId]);
    } else {
      this._run('UPDATE ads SET last_seen = ?, updated_at = ? WHERE id = ?', [nowIso, nowIso, adId]);
    }
  }

  setAdLatestPrice(adId, price, atIso) {
    this._run('UPDATE ads SET latest_price = ?, latest_price_at = ? WHERE id = ?', [price, atIso, adId]);
  }

  setAdQuality(adId, quality) {
    this._run('UPDATE ads SET quality_json = ? WHERE id = ?', [JSON.stringify(quality), adId]);
  }

  /** Liste paginée d'annonces (jamais toute la base en une fois). */
  listAds({ limit = 100, offset = 0 } = {}) {
    return this._all('SELECT * FROM ads ORDER BY last_seen DESC LIMIT ? OFFSET ?', [limit, offset]);
  }

  countAds() {
    const r = this._get('SELECT COUNT(*) AS n FROM ads');
    return r ? r.n : 0;
  }

  // ─── Produits ──────────────────────────────────────────────────────────────

  getProductByKey(canonicalKey) {
    return this._get('SELECT * FROM products WHERE canonical_key = ?', [canonicalKey]);
  }

  getProduct(productId) {
    return this._get('SELECT * FROM products WHERE id = ?', [productId]);
  }

  insertProduct(product, nowIso) {
    const info = this._run(
      `INSERT INTO products (canonical_key, reference, brand, family, label, units_json,
        title_tokens, status, rules_version, provenance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [product.canonicalKey, product.reference || null, product.brand || null, product.family || null,
        product.label || null, product.units ? JSON.stringify(product.units) : null,
        product.titleTokens ? JSON.stringify(product.titleTokens) : null,
        product.status || 'provisional', product.rulesVersion || 1,
        product.provenance || null, nowIso, nowIso]
    );
    return Number(info.lastInsertRowid);
  }

  updateProduct(productId, patch, nowIso) {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(patch || {})) {
      const col = { reference: 'reference', brand: 'brand', family: 'family', label: 'label', status: 'status', provenance: 'provenance', rulesVersion: 'rules_version', units: 'units_json', titleTokens: 'title_tokens' }[k];
      if (!col) continue;
      fields.push(`${col} = ?`);
      params.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(nowIso, productId);
    this._run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  listProducts({ limit = 200, offset = 0, family = null, q = null } = {}) {
    let sql = 'SELECT * FROM products';
    const where = [];
    const params = [];
    if (family) { where.push('family = ?'); params.push(family); }
    if (q) { where.push('(label LIKE ? OR reference LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this._all(sql, params);
  }

  countProducts() {
    const r = this._get('SELECT COUNT(*) AS n FROM products');
    return r ? r.n : 0;
  }

  /** Familles distinctes présentes (pour les filtres de l'interface). */
  listFamilies() {
    return this._all("SELECT DISTINCT family FROM products WHERE family IS NOT NULL AND family <> '' ORDER BY family")
      .map((r) => r.family);
  }

  // ─── Liens annonce ↔ produit ───────────────────────────────────────────────

  upsertLink(link) {
    const existing = this._get('SELECT * FROM ad_product_links WHERE ad_id = ?', [link.adId]);
    if (existing) {
      this._run(
        `UPDATE ad_product_links SET product_id = ?, decision = ?, link_status = ?, score = ?,
           reasons_json = ?, contradictions_json = ?, candidates_json = ?,
           algorithm_version = ?, decided_at = ? WHERE ad_id = ?`,
        [link.productId || null, link.decision, link.linkStatus || 'auto', link.score ?? null,
          link.reasons ? JSON.stringify(link.reasons) : null,
          link.contradictions ? JSON.stringify(link.contradictions) : null,
          link.candidates ? JSON.stringify(link.candidates) : null,
          link.algorithmVersion || 1, link.decidedAt, link.adId]
      );
      return existing.id;
    }
    const info = this._run(
      `INSERT INTO ad_product_links (ad_id, product_id, decision, link_status, score,
        reasons_json, contradictions_json, candidates_json, algorithm_version, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [link.adId, link.productId || null, link.decision, link.linkStatus || 'auto', link.score ?? null,
        link.reasons ? JSON.stringify(link.reasons) : null,
        link.contradictions ? JSON.stringify(link.contradictions) : null,
        link.candidates ? JSON.stringify(link.candidates) : null,
        link.algorithmVersion || 1, link.decidedAt]
    );
    return Number(info.lastInsertRowid);
  }

  getLink(adId) { return this._get('SELECT * FROM ad_product_links WHERE ad_id = ?', [adId]); }

  listLinksByProduct(productId, { statuses = null } = {}) {
    if (Array.isArray(statuses) && statuses.length) {
      const ph = statuses.map(() => '?').join(',');
      return this._all(`SELECT * FROM ad_product_links WHERE product_id = ? AND link_status IN (${ph})`, [productId, ...statuses]);
    }
    return this._all('SELECT * FROM ad_product_links WHERE product_id = ?', [productId]);
  }

  /** File des rapprochements incertains (jamais auto-associés). */
  listPendingLinks({ limit = 100, offset = 0 } = {}) {
    return this._all(
      `SELECT l.*, a.title AS ad_title, a.url AS ad_url, a.reference AS ad_reference, a.family AS ad_family
       FROM ad_product_links l JOIN ads a ON a.id = l.ad_id
       WHERE l.link_status IN ('pending','rejected') ORDER BY l.decided_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }

  countPendingLinks() {
    const r = this._get("SELECT COUNT(*) AS n FROM ad_product_links WHERE link_status IN ('pending','rejected')");
    return r ? r.n : 0;
  }

  // ─── Observations ──────────────────────────────────────────────────────────

  getLastObservation(adId) {
    return this._get('SELECT * FROM observations WHERE ad_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1', [adId]);
  }

  insertObservation(obs) {
    const info = this._run(
      `INSERT INTO observations (ad_id, observed_at, price, currency, condition, offer_type,
        availability, source_job, features_json, price_valid, price_reason, flags_json, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [obs.adId, obs.observedAt, obs.price ?? null, obs.currency || 'EUR', obs.condition || null,
        obs.offerType || null, obs.availability || null, obs.sourceJob || null,
        obs.features ? JSON.stringify(obs.features) : null,
        obs.priceValid === false ? 0 : 1, obs.priceReason || null,
        obs.flags ? JSON.stringify(obs.flags) : null,
        obs.origin === 'imported' ? 'imported' : 'live']
    );
    return Number(info.lastInsertRowid);
  }

  listObservations(adId) {
    return this._all('SELECT * FROM observations WHERE ad_id = ? ORDER BY observed_at ASC, id ASC', [adId]);
  }

  countObservations() {
    const r = this._get('SELECT COUNT(*) AS n FROM observations');
    return r ? r.n : 0;
  }

  // ─── Alias ─────────────────────────────────────────────────────────────────

  addAlias(productId, alias, normalized, source, confidence, nowIso) {
    if (!normalized) return;
    // Provenance obligatoire : un alias « observed » (cooccurrence) n'a pas la
    // même force qu'un alias « manual » (correction utilisateur validée).
    this._run(
      `INSERT INTO aliases (product_id, alias, normalized, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_id, normalized) DO UPDATE SET
         confidence = MAX(COALESCE(confidence,0), COALESCE(excluded.confidence,0)),
         source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE aliases.source END`,
      [productId, alias, normalized, source || 'observed', confidence ?? null, nowIso]
    );
    // Index global : ne remplace PAS une entrée manuelle existante.
    const cur = this._get('SELECT product_id FROM product_aliases_index WHERE normalized = ?', [normalized]);
    if (!cur) {
      this._run('INSERT OR IGNORE INTO product_aliases_index (normalized, product_id, created_at) VALUES (?, ?, ?)', [normalized, productId, nowIso]);
    }
  }

  listAliases(productId) {
    return this._all('SELECT * FROM aliases WHERE product_id = ? ORDER BY created_at ASC', [productId]);
  }

  findProductIdByAlias(normalized) {
    const r = this._get('SELECT product_id FROM product_aliases_index WHERE normalized = ?', [normalized]);
    return r ? r.product_id : null;
  }

  // ─── Corrections manuelles ─────────────────────────────────────────────────

  addCorrection(correction) {
    const info = this._run(
      `INSERT INTO ad_corrections (ad_id, action, from_product_id, to_product_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [correction.adId, correction.action, correction.fromProductId ?? null,
        correction.toProductId ?? null, correction.note || null, correction.createdAt]
    );
    return Number(info.lastInsertRowid);
  }

  listCorrections(adId = null) {
    if (adId != null) return this._all('SELECT * FROM ad_corrections WHERE ad_id = ? ORDER BY created_at ASC', [adId]);
    return this._all('SELECT * FROM ad_corrections ORDER BY created_at DESC LIMIT 500');
  }

  /** Annonces explicitement corrigées (jamais réécrites par le moteur auto). */
  manuallyLinkedAdIds() {
    const rows = this._all("SELECT ad_id FROM ad_product_links WHERE link_status = 'manual'");
    return new Set(rows.map((r) => r.ad_id));
  }

  // ─── Cache de statistiques ─────────────────────────────────────────────────

  getStatsCache(cacheKey) {
    return this._get('SELECT * FROM stats_cache WHERE cache_key = ?', [cacheKey]);
  }

  putStatsCache(cacheKey, productId, payload, algorithmVersion, nowIso) {
    this._run(
      `INSERT INTO stats_cache (cache_key, product_id, payload_json, computed_at, algorithm_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json,
         computed_at = excluded.computed_at, algorithm_version = excluded.algorithm_version`,
      [cacheKey, productId ?? null, JSON.stringify(payload), nowIso, algorithmVersion || 1]
    );
  }

  invalidateStatsCache(productId = null) {
    if (productId == null) this._run('DELETE FROM stats_cache');
    else this._run('DELETE FROM stats_cache WHERE product_id = ? OR product_id IS NULL', [productId]);
  }
}

module.exports = { PriceHistoryDb, isAvailable, MIGRATIONS, sqliteError };
