'use strict';

/**
 * featureExtractor — extraction DÉTERMINISTE de caractéristiques d'une annonce.
 *
 * Module PUR (aucune dépendance Electron/IA/réseau). À partir du titre et de la
 * description d'une annonce, produit un objet de caractéristiques :
 *
 *   { brand, family, familyLabel, primaryReference, referenceTokens,
 *     units, condition, conditionSource, offerType, quantity,
 *     titleTokens, descTokens, contradictions, hasDescription }
 *
 * Principes :
 *   - Aucune donnée inventée : un champ non trouvé vaut `null`.
 *   - Le titre et la description sont traités comme des DONNÉES (jamais exécutés).
 *   - Les descripteurs (marques, familles, unités, indices) sont déclaratifs
 *     (lexicons.js) : on étend le moteur sans réécrire la logique.
 */

const { normalizeText, tokenize } = require('./normalizeText');
const {
  PRODUCT_FAMILIES,
  KNOWN_BRANDS,
  CONDITION_HINTS,
  OFFER_HINTS,
  UNIT_PATTERNS,
} = require('./lexicons');

// Suffixes de modèle qui font partie intégrante de la référence lorsqu'ils
// suivent immédiatement un nombre : « 3060 Ti », « 9600 X », « 4070 Super »,
// « 13600 K », « 2080 Super », « 1080 Ti ». Les joindre évite de confondre
// RTX 3060 et RTX 3060 Ti (modèles différents).
const MODEL_SUFFIXES = new Set([
  'x', 'xt', 'xtx', 'ti', 'super', 'k', 'kf', 'ks', 'ka', 'f', 'g', 't', 's',
  'se', 'pro', 'max', 'plus', 'ultra', 'lite', 'mini', 'air', 'note', 'fold',
  'zoom', 'fe', 'oc', 'gaming', 'xt', 'xs', 'nr', 've', 'gti', 'e', 'd',
]);

// Unités reconnues : mot → { key, unit }.
const UNIT_WORDS = {
  go: { key: 'capacity_gb', unit: 'GB' }, gb: { key: 'capacity_gb', unit: 'GB' },
  giga: { key: 'capacity_gb', unit: 'GB' }, gigaoctets: { key: 'capacity_gb', unit: 'GB' },
  to: { key: 'capacity_tb', unit: 'TB' }, tb: { key: 'capacity_tb', unit: 'TB' },
  tera: { key: 'capacity_tb', unit: 'TB' }, teraoctets: { key: 'capacity_tb', unit: 'TB' },
  mo: { key: 'capacity_mb', unit: 'MB' }, mb: { key: 'capacity_mb', unit: 'MB' },
  w: { key: 'power_w', unit: 'W' }, watt: { key: 'power_w', unit: 'W' }, watts: { key: 'power_w', unit: 'W' },
  ghz: { key: 'frequency_ghz', unit: 'GHz' },
  mhz: { key: 'frequency_mhz', unit: 'MHz' },
  coeur: { key: 'cores', unit: 'cores' }, coeurs: { key: 'cores', unit: 'cores' },
  core: { key: 'cores', unit: 'cores' }, cores: { key: 'cores', unit: 'cores' },
  thread: { key: 'threads', unit: 'threads' }, threads: { key: 'threads', unit: 'threads' },
  hz: { key: 'refresh_hz', unit: 'Hz' },
  pouce: { key: 'size_inch', unit: 'in' }, pouces: { key: 'size_inch', unit: 'in' },
  inch: { key: 'size_inch', unit: 'in' }, inches: { key: 'size_inch', unit: 'in' },
  nm: { key: 'process_nm', unit: 'nm' },
};

const UNIT_KEY_PRIORITY = {
  capacity_tb: 6, capacity_gb: 5, capacity_mb: 4, power_w: 3,
  size_inch: 3, frequency_ghz: 2, frequency_mhz: 2, refresh_hz: 2,
  cores: 2, threads: 2, process_nm: 1,
};

/**
 * Normalise un texte en préservant les nombres décimaux et les jetons
 * alphanumériques collés (ex. « 9600X », « 3.5GHz », « 32Go »).
 * @param {*} input
 * @returns {string}
 */
function normalizeForTokens(input) {
  if (input == null) return '';
  let s = String(input).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  s = s.replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'");
  s = s.replace(/[\u201c\u201d\u00ab\u00bb"]/g, ' ');
  // Protège le séparateur décimal entre deux chiffres (3.5, 2,5).
  s = s.replace(/(\d)[.,](\d)/g, '$1\u00a7$2');
  s = s.replace(/[^a-z0-9\u00a7]+/g, ' ');
  s = s.replace(/\u00a7/g, '.');
  return s.trim().replace(/\s+/g, ' ');
}

/** Découpe en jetons avec positions. @returns {Array<{t:string,s:number,e:number}>} */
function tokenizeSpans(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  }
  return out;
}

/**
 * Extrait les unités/capacités (32 Go, 500 W, 3.5 GHz…) et les plages de
 * caractères consommées (pour ne pas les confondre avec une référence).
 * @param {string} text texte normalisé
 * @returns {{units: Object, spans: Array<{s:number,e:number}>}}
 */
function extractUnits(text) {
  const units = {};
  const spans = [];
  for (const pat of UNIT_PATTERNS) {
    const re = new RegExp(pat.re.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].replace(',', '.');
      const num = parseFloat(raw);
      if (!Number.isFinite(num)) continue;
      const key = pat.key;
      // Une unité plus spécifique prime (TB > GB, etc.). On ne remplace pas
      // une valeur déjà trouvée par une de moindre priorité.
      const prev = units[key];
      if (!prev || (UNIT_KEY_PRIORITY[key] || 0) >= 0) {
        if (!prev) units[key] = { value: num, unit: pat.unit, raw: m[0].trim() };
      }
      spans.push({ s: m.index, e: m.index + m[0].length });
    }
  }
  // Kit RAM « 2x8Go » / « 2 x 8 go » : total = n × taille.
  const kitRe = /\b(\d{1,2})\s?x\s?(\d{1,3})\s?(?:go|gb)\b/g;
  let km;
  while ((km = kitRe.exec(text)) !== null) {
    const count = parseInt(km[1], 10);
    const size = parseInt(km[2], 10);
    if (count >= 2 && size > 0) {
      units.kit_ram = { value: count * size, count, size, unit: 'GB', raw: km[0].trim() };
      spans.push({ s: km.index, e: km.index + km[0].length });
    }
  }
  return { units, spans };
}

/** Vrai si un jeton chevauche une plage consommée par une unité. */
function overlapsAny(span, spans) {
  for (const sp of spans) {
    if (span.s < sp.e && span.e > sp.s) return true;
  }
  return false;
}

/**
 * Construit les unités de référence (identifiants de modèle) à partir des
 * jetons non consommés par une unité. Une unité de référence = un jeton
 * contenant au moins un chiffre, éventuellement étendu par un suffixe de modèle
 * adjacent (« 3060 » + « ti » → « 3060TI »).
 * @param {Array<{t:string,s:number,e:number}>} tokens
 * @param {Array<{s:number,e:number}>} unitSpans
 * @returns {string[]} références normalisées (majuscules alphanumériques)
 */
function extractReferenceUnits(tokens, unitSpans) {
  const refs = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (overlapsAny(tok, unitSpans)) continue;
    if (!/\d/.test(tok.t)) continue;
    // Jeton alphanumérique contenant un chiffre.
    let ref = tok.t.replace(/[^a-z0-9]/g, '');
    if (ref === '') continue;
    // Extension par suffixe(s) de modèle adjacent(s) : « 3060 » « ti ».
    let j = i + 1;
    while (j < tokens.length && !overlapsAny(tokens[j], unitSpans)) {
      const nx = tokens[j].t.replace(/[^a-z0-9]/g, '');
      if (nx && !/\d/.test(nx) && MODEL_SUFFIXES.has(nx) && nx.length <= 6) {
        ref += nx;
        j++;
      } else break;
    }
    refs.push(ref.toUpperCase());
  }
  // Dédoublonne en conservant l'ordre.
  return [...new Set(refs)];
}

/**
 * Choisit la référence PRINCIPALE : la plus discriminante. On privilégie la
 * longueur (nombre de caractères), puis le nombre de chiffres, puis l'ordre
 * d'apparition. « 9600X » (5) > « 5 » (1) ; « 3060TI » (6) > « 12 ».
 * @param {string[]} refs
 * @returns {string|null}
 */
function pickPrimaryReference(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const r of refs) {
    const digits = (r.match(/\d/g) || []).length;
    const score = r.length * 10 + digits;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/** Détecte la famille de produit : celle dont l'indice apparaît le plus tôt. */
function detectFamily(text, tokens) {
  let best = null;
  let bestPos = Infinity;
  for (const fam of PRODUCT_FAMILIES) {
    for (const hint of fam.hints) {
      const h = normalizeText(hint);
      if (h === '') continue;
      // Indice mono-mot : recherche sur les jetons. Indice multi-mots : recherche
      // sur le texte normalisé (positions approximées par indexOf).
      let pos = -1;
      if (h.includes(' ')) {
        pos = text.indexOf(h);
      } else {
        const idx = tokens.findIndex((tk) => tk.t === h);
        if (idx >= 0) pos = idx * 1000;
      }
      if (pos >= 0 && pos < bestPos) { bestPos = pos; best = fam; }
    }
  }
  return best ? { id: best.id, label: best.label } : { id: null, label: null };
}

/** Détecte la marque explicite (première marque connue rencontrée). */
function detectBrand(text, tokens) {
  const tokenSet = new Set(tokens.map((t) => t.t));
  let best = null;
  let bestPos = Infinity;
  for (const brand of KNOWN_BRANDS) {
    const b = normalizeText(brand);
    if (b === '') continue;
    let pos = -1;
    if (b.includes(' ')) {
      pos = text.indexOf(b);
    } else if (tokenSet.has(b)) {
      pos = tokens.findIndex((t) => t.t === b) * 1000;
    }
    if (pos >= 0 && pos < bestPos) { bestPos = pos; best = brand; }
  }
  return best;
}

/**
 * Détecte l'état du produit dans un texte. Renvoie { condition, hits } où
 * condition ∈ {new, used, for_parts, null}.
 * Priorité : for_parts > new > used (un « neuf » accompagné de « hs » est
 * ambigu et sera signalé comme contradiction ailleurs).
 */
function detectConditionIn(text) {
  const hits = { new: [], used: [], for_parts: [] };
  for (const [key, words] of Object.entries(CONDITION_HINTS)) {
    for (const w of words) {
      const nw = normalizeText(w);
      if (nw && text.includes(nw)) hits[key].push(nw);
    }
  }
  let condition = null;
  if (hits.for_parts.length) condition = 'for_parts';
  else if (hits.new.length) condition = 'new';
  else if (hits.used.length) condition = 'used';
  return { condition, hits };
}

/** Détecte le type d'offre à partir du texte (titre + description). */
function detectOfferType(titleText, descText, family) {
  const combined = `${titleText} ${descText}`;
  const flags = { lot: false, accessory: false, accessory_bundle: false, part: false, quantity: false };
  const has = (arr) => arr.some((w) => { const n = normalizeText(w); return n && combined.includes(n); });
  flags.lot = has(OFFER_HINTS.lot);
  flags.accessory = has(OFFER_HINTS.accessory);
  flags.accessory_bundle = has(OFFER_HINTS.accessory_bundle);
  flags.part = has(OFFER_HINTS.parts);
  flags.quantity = has(OFFER_HINTS.quantity);

  // Quantité explicite « x3 » ou « lot de 3 ».
  let quantity = null;
  const qm = combined.match(/\bx\s?(\d{1,3})\b/) || combined.match(/\blot de (\d{1,3})\b/);
  if (qm) quantity = parseInt(qm[1], 10);
  if (quantity == null && /\bpaire\b/.test(combined)) quantity = 2;

  // Famille « accessoire » : la famille détectée est elle-même un accessoire
  // (refroidissement seul) et aucun indice de bundle n'est présent.
  const accessoryFamilies = new Set(['cooler']);
  let offerType = 'single';
  if (flags.part) offerType = 'part';
  else if (flags.lot || (quantity && quantity >= 2 && flags.lot)) offerType = 'lot';
  else if (flags.quantity && quantity && quantity >= 2) offerType = 'quantity';
  else if (family && accessoryFamilies.has(family.id) && !flags.accessory_bundle) offerType = 'accessory_only';
  else if (flags.accessory && !flags.accessory_bundle && !family) offerType = 'accessory_only';
  else if (flags.accessory_bundle) offerType = 'with_accessories';
  return { offerType, quantity, flags };
}

/**
 * Extrait toutes les caractéristiques d'une annonce.
 * @param {Object} ad annonce (title, description, etat éventuel)
 * @returns {Object} caractéristiques structurées
 */
function extractFeatures(ad) {
  const a = ad && typeof ad === 'object' ? ad : {};
  const title = typeof a.title === 'string' ? a.title : '';
  const description = typeof a.description === 'string' ? a.description : '';

  const titleText = normalizeForTokens(title);
  const descText = normalizeForTokens(description);
  const titleTokens = tokenizeSpans(titleText);
  const descTokens = tokenizeSpans(descText);

  const { units, spans: titleUnitSpans } = extractUnits(titleText);
  const { units: descUnits } = extractUnits(descText);
  // Fusion : les unités du titre priment, complétées par la description.
  const mergedUnits = { ...descUnits, ...units };

  const titleRefs = extractReferenceUnits(titleTokens, titleUnitSpans);
  const descRefs = extractReferenceUnits(descTokens, []);
  // Références : titre prioritaire ; si le titre n'en a aucune, la description
  // peut en fournir (ex. titre générique + description précise).
  const referenceTokens = titleRefs.length > 0 ? titleRefs : descRefs;
  const primaryReference = pickPrimaryReference(referenceTokens);

  const family = detectFamily(`${titleText} ${descText}`, titleTokens);
  const brand = detectBrand(`${titleText} ${descText}`, titleTokens);

  const condTitle = detectConditionIn(titleText);
  const condDesc = detectConditionIn(descText);
  // État : on retient l'état STRUCTURÉ déclaré (attribut Leboncoin) s'il existe,
  // sinon l'état déduit du texte (titre prioritaire).
  let condition = null;
  let conditionSource = null;
  const declared = normalizeDeclaredCondition(a.etat);
  if (declared) { condition = declared; conditionSource = 'declared'; }
  else if (condTitle.condition) { condition = condTitle.condition; conditionSource = 'title'; }
  else if (condDesc.condition) { condition = condDesc.condition; conditionSource = 'description'; }

  const offer = detectOfferType(titleText, descText, family);

  // Contradictions explicites titre/description.
  const contradictions = [];
  if (condTitle.condition && condDesc.condition && condTitle.condition !== condDesc.condition) {
    // « neuf » (titre) vs « à réparer » (description) → contradiction forte.
    const strong = new Set(['new', 'for_parts']);
    if (strong.has(condTitle.condition) && strong.has(condDesc.condition)) {
      contradictions.push({
        type: 'condition_title_description',
        title: condTitle.condition,
        description: condDesc.condition,
        severity: 'high',
      });
    } else {
      contradictions.push({
        type: 'condition_title_description',
        title: condTitle.condition,
        description: condDesc.condition,
        severity: 'medium',
      });
    }
  }
  // Référence du titre vs référence de la description : si les deux existent et
  // diffèrent, c'est une contradiction d'identité (le titre peut être erroné).
  if (titleRefs.length > 0 && descRefs.length > 0) {
    const pt = pickPrimaryReference(titleRefs);
    const pd = pickPrimaryReference(descRefs);
    if (pt && pd && pt !== pd) {
      contradictions.push({
        type: 'reference_title_description',
        title: pt,
        description: pd,
        severity: 'high',
      });
    }
  }

  return {
    brand: brand || null,
    family: family.id,
    familyLabel: family.label,
    primaryReference,
    referenceTokens,
    units: mergedUnits,
    condition,
    conditionSource,
    offerType: offer.offerType,
    quantity: offer.quantity,
    offerFlags: offer.flags,
    titleTokens: titleTokens.map((t) => t.t),
    descTokens: descTokens.map((t) => t.t),
    contradictions,
    hasDescription: description.trim() !== '',
  };
}

/**
 * Convertit l'état déclaré Leboncoin (attribut structuré) en code interne.
 * @param {*} etat
 * @returns {string|null} new | used | for_parts | null
 */
function normalizeDeclaredCondition(etat) {
  if (etat == null) return null;
  const s = normalizeText(etat);
  if (s === '') return null;
  if (/neuf|new|jamais/.test(s)) return 'new';
  if (/pour piece|a reparer|hs|hors service|panne|defectueux|non fonctionnel/.test(s)) return 'for_parts';
  if (/occasion|bon etat|tres bon|correct|utilise|reconditionne|usage/.test(s)) return 'used';
  return null;
}

module.exports = {
  normalizeForTokens,
  tokenizeSpans,
  extractUnits,
  extractReferenceUnits,
  pickPrimaryReference,
  detectFamily,
  detectBrand,
  detectConditionIn,
  detectOfferType,
  extractFeatures,
  normalizeDeclaredCondition,
  MODEL_SUFFIXES,
  UNIT_WORDS,
};
