'use strict';

/**
 * exportFields — module central de configuration des exports.
 *
 * Définit :
 *   - DEFAULT_FIELDS : la liste exhaustive des champs disponibles (mode Défaut).
 *   - FIELD_CATEGORIES : regroupement par catégorie pour faciliter la sélection UI.
 *   - filterAdByFields(ad, fields) : filtre un objet annonce selon un set de champs.
 *   - toReadableBlock(ad, fields, index) : bloc TXT lisible (1 annonce), aligné
 *     sur le mode choisi. Renvoie une string (jamais un objet, jamais undefined).
 *   - toShortText(ads, fields) : sérialisation ultra-compacte avec échappement
 *     fiable (séparateur \x1F, échappement \x1E) du MÊME contenu que le TXT.
 *
 * RÈGLE FONDAMENTALE :
 *   - Mode Défaut    → toutes les informations sont exportées.
 *   - Mode Personnalisé → UNIQUEMENT les champs sélectionnés (1, plusieurs,
 *     ou quasi-tous). Les champs absents ne figurent ni dans le JSON, ni dans
 *     le TXT, ni dans le Texte raccourci.
 *
 * Le Texte raccourci doit être strictement dérivé des mêmes données que le
 * TXT (aucune perte d'information) : on sérialise chaque champ `key=value`
 * avec un séparateur \x1F et un échappement \x1E (style length-prefixed, sûr
 * pour toute valeur, y compris \x1F, \x1E, \x00, sauts de ligne, etc.).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Définition des champs exportables (mode Défaut)
// ─────────────────────────────────────────────────────────────────────────────
//
// On couvre tous les champs actuellement produits par adFields.js + normalizeAd,
// ainsi que les analyses IA (champ identifié par l'IA + résumé + valeur marché).
// L'ordre est FIXE pour conserver la lisibilité TXT.
//
// Chaque champ est décrit par :
//   - key     : identifiant (utilisé dans le JSON, le TXT label et la clé courte)
//   - label   : libellé humain affiché dans le TXT normal
//   - short   : code 1-2 lettres utilisé dans le Texte raccourci (pour gagner
//               de la place quand on génère la forme compacte)
//   - get     : extracteur (ad) => valeur ou null
//   - fmt     : (optionnel) formateur pour le TXT normal, sinon String(v) suffit
//
// Le Texte raccourci utilise par défaut les `short`. Les séparateurs et
// l'échappement sont définis plus bas.

const DEFAULT_FIELDS = [
  // ─── IDENTIFICATION ───────────────────────────────────────────────────────
  { key: 'id',          label: 'ID',                          short: 'I', get: (a) => a.id ?? null },
  { key: 'title',       label: 'Titre',                       short: 'T', get: (a) => a.title ?? null },
  { key: 'url',         label: 'URL',                         short: 'U', get: (a) => a.url ?? null },

  // ─── PRODUIT IDENTIFIÉ (IA) ───────────────────────────────────────────────
  { key: 'produitIdentifie',  label: 'Produit identifié (IA)',  short: 'Pi', get: (a) => (a.adAnalysis && a.adAnalysis.identifiedProduct) || null },
  { key: 'resumeIA',          label: 'Résumé IA',               short: 'Ri', get: (a) => (a.adAnalysis && a.adAnalysis.summary) || null },

  // ─── PRIX ─────────────────────────────────────────────────────────────────
  { key: 'prix',        label: 'Prix',                        short: 'P', get: (a) => a.prix ?? null, fmt: (v) => v != null ? `${v} €` : 'null' },

  // ─── LOCALISATION ────────────────────────────────────────────────────────
  { key: 'ville',       label: 'Ville',                       short: 'V', get: (a) => a.city ?? null },
  { key: 'codePostal',  label: 'Code postal',                 short: 'Cp', get: (a) => a.zipcode ?? null },

  // ─── VENDEUR ─────────────────────────────────────────────────────────────
  { key: 'vendeurNom',          label: 'Vendeur (nom)',           short: 'Vn', get: (a) => a.vendeurNom ?? null },
  { key: 'vendeurType',         label: 'Vendeur (type)',          short: 'Vt', get: (a) => a.vendeurType ?? null },
  { key: 'vendeurId',           label: 'Vendeur (ID)',            short: 'Vi', get: (a) => a.vendeurId ?? null },
  { key: 'vendeurNote',         label: 'Vendeur (note)',          short: 'Vr', get: (a) => a.vendeurNote ?? null, fmt: (v) => v != null ? `${v}/5` : 'null' },
  { key: 'vendeurNbAvis',       label: 'Vendeur (nb avis)',       short: 'Va', get: (a) => a.nombreAvis ?? null },
  { key: 'vendeurUrlProfil',    label: 'Vendeur (URL profil)',    short: 'Vp', get: (a) => a.vendeurUrlProfil ?? null },
  { key: 'vendeurAnciennete',   label: 'Vendeur (ancienneté, jours)', short: 'Ve', get: (a) => a.vendeurAncienneteJours ?? null },

  // ─── TRANSACTION ─────────────────────────────────────────────────────────
  { key: 'livraison',   label: 'Livraison',                   short: 'L',  get: (a) => a.livraison ?? null, fmt: (v) => v === true ? 'OUI' : (v === false ? 'NON' : 'null') },
  { key: 'mainPropre',  label: 'Main propre',                 short: 'M',  get: (a) => a.mainPropre ?? null, fmt: (v) => v === true ? 'OUI' : (v === false ? 'NON' : 'null') },

  // ─── STATS / DATES ───────────────────────────────────────────────────────
  { key: 'likes',              label: 'Likes',            short: 'Lk', get: (a) => a.likes ?? null },
  { key: 'datePublication',    label: 'Date publication', short: 'Dp', get: (a) => _fmtDate(a.datePublication) },
  { key: 'dateModification',   label: 'Date modification', short: 'Dm', get: (a) => _fmtDate(a.dateModification) },
  { key: 'dateScraping',       label: 'Date scraping',     short: 'Ds', get: (a) => _fmtDate(a.dateScraping) },

  // ─── PRODUIT / ÉTAT ──────────────────────────────────────────────────────
  { key: 'etat',       label: 'État déclaré',                 short: 'E',  get: (a) => a.etat ?? null },

  // ─── PHOTOS (NB uniquement, URLs exclues du short text par défaut) ──────
  { key: 'photosCount', label: 'Nombre de photos',            short: 'N',  get: (a) => a.photosCount ?? null },
  { key: 'photosUrls',  label: 'URLs des photos',             short: 'Pu', get: (a) => Array.isArray(a.photosUrls) ? a.photosUrls.join(',') : null },

  // ─── DESCRIPTION ─────────────────────────────────────────────────────────
  { key: 'description', label: 'Description',                 short: 'D',  get: (a) => _descString(a) },

  // ─── ANALYSE MARCHÉ (IA 2) ───────────────────────────────────────────────
  { key: 'verdict',     label: 'Verdict IA Marché',           short: 'Vm', get: (a) => (a.marketAnalysis && a.marketAnalysis.verdictLabel) || null },
  { key: 'valeurMarche', label: 'Valeur marché (€)',           short: 'W',  get: (a) => (a.marketAnalysis && a.marketAnalysis.realValue != null) ? a.marketAnalysis.realValue : null },
  { key: 'fourchette',  label: 'Fourchette marché (€)',        short: 'F',  get: (a) => (a.marketAnalysis && a.marketAnalysis.valueRangeLow != null && a.marketAnalysis.valueRangeHigh != null) ? `${a.marketAnalysis.valueRangeLow} € - ${a.marketAnalysis.valueRangeHigh} €` : null },
  { key: 'benefice',    label: 'Bénéfice/Perte (€)',           short: 'B',  get: (a) => (a.marketAnalysis && a.marketAnalysis.deltaEur != null) ? a.marketAnalysis.deltaEur : null },
  { key: 'justification', label: 'Justification IA Marché',    short: 'J',  get: (a) => (a.marketAnalysis && a.marketAnalysis.rationale) || null },
];

// Regroupement par catégorie pour la sélection UI en mode Personnalisé.
const FIELD_CATEGORIES = [
  {
    id: 'identification',
    label: 'Identification',
    keys: ['id', 'title', 'url'],
  },
  {
    id: 'prix',
    label: 'Prix',
    keys: ['prix'],
  },
  {
    id: 'localisation',
    label: 'Localisation',
    keys: ['ville', 'codePostal'],
  },
  {
    id: 'vendeur',
    label: 'Vendeur',
    keys: ['vendeurNom', 'vendeurType', 'vendeurId', 'vendeurNote', 'vendeurNbAvis', 'vendeurUrlProfil', 'vendeurAnciennete'],
  },
  {
    id: 'transaction',
    label: 'Transaction',
    keys: ['livraison', 'mainPropre'],
  },
  {
    id: 'dates',
    label: 'Dates',
    keys: ['datePublication', 'dateModification', 'dateScraping'],
  },
  {
    id: 'stats',
    label: 'Statistiques',
    keys: ['likes'],
  },
  {
    id: 'produit',
    label: 'Produit',
    keys: ['etat'],
  },
  {
    id: 'photos',
    label: 'Photos',
    keys: ['photosCount', 'photosUrls'],
  },
  {
    id: 'description',
    label: 'Description',
    keys: ['description'],
  },
  {
    id: 'ia',
    label: 'Analyses IA',
    keys: ['produitIdentifie', 'resumeIA', 'verdict', 'valeurMarche', 'fourchette', 'benefice', 'justification'],
  },
];

// Liste complète des clés pour faciliter les UI « Tout sélectionner ».
const ALL_FIELD_KEYS = DEFAULT_FIELDS.map((f) => f.key);

// Map rapide key → fieldDef (utilisée par les exporters)
const FIELDS_BY_KEY = (() => {
  const m = {};
  for (const f of DEFAULT_FIELDS) m[f.key] = f;
  return m;
})();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formatage (alignés sur toReadableBlock existant)
// ─────────────────────────────────────────────────────────────────────────────

function _fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _descString(ad) {
  if (!ad) return '';
  if (typeof ad.description === 'string') return ad.description;
  if (ad.description && typeof ad.description === 'object' && typeof ad.description.originale === 'string') {
    return ad.description.originale;
  }
  return '';
}

function _formatValue(fieldDef, value) {
  if (value == null) return 'null';
  if (typeof fieldDef.fmt === 'function') return fieldDef.fmt(value);
  if (typeof value === 'string') return value;
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtrage des annonces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit un objet ne contenant que les champs sélectionnés.
 * Si `fields` est null/undefined ou contient toutes les clés → renvoie l'objet
 * tel quel (mode Défaut).
 *
 * ⚠️ Ne supprime PAS `adAnalysis` / `marketAnalysis` du JSON — ils sont
 * disponibles comme champs granulaires via DEFAULT_FIELDS, mais conservés
 * en bloc dans la racine pour ne pas casser les consommateurs (UI, IA).
 *
 * En mode Personnalisé, on retire les blocs IA de la racine pour respecter
 * strictement le mode (sinon l'utilisateur aurait accès à des données qu'il
 * n'a pas explicitement sélectionnées via l'UI).
 */
function filterAdByFields(ad, fields) {
  if (!ad || typeof ad !== 'object') return ad;
  // Mode Défaut (= null, undefined, ou contenant toutes les clés) → objet tel quel
  if (!fields || !Array.isArray(fields) || fields.length === 0) return ad;
  if (fields.length >= ALL_FIELD_KEYS.length && ALL_FIELD_KEYS.every((k) => fields.includes(k))) {
    return ad;
  }
  // Clés d'analyse IA : mappées vers les blocs adAnalysis / marketAnalysis
  // (elles ne sont pas présentes directement à la racine de l'ad).
  const IA_TO_AD_ANALYSIS = { produitIdentifie: 'identifiedProduct', resumeIA: 'summary' };
  const IA_TO_MARKET = {
    verdict: 'verdictLabel', valeurMarche: 'realValue', fourchette: null, benefice: 'deltaEur', justification: 'rationale',
  };

  const out = {};
  // Copie les clés racines existantes dans la sélection
  for (const key of fields) {
    if (IA_TO_AD_ANALYSIS[key] || IA_TO_MARKET[key]) continue; // traitées séparément
    if (Object.prototype.hasOwnProperty.call(ad, key)) out[key] = ad[key];
  }
  // adAnalysis slim
  const hasAdAnalysis = fields.some((k) => k in IA_TO_AD_ANALYSIS);
  if (hasAdAnalysis && ad.adAnalysis && typeof ad.adAnalysis === 'object') {
    const slim = {};
    for (const k of fields) {
      const m = IA_TO_AD_ANALYSIS[k];
      if (m && ad.adAnalysis[m] != null) slim[m] = ad.adAnalysis[m];
    }
    if (Object.keys(slim).length > 0) out.adAnalysis = slim;
  }
  // marketAnalysis slim
  const hasMarket = fields.some((k) => k in IA_TO_MARKET);
  if (hasMarket && ad.marketAnalysis && typeof ad.marketAnalysis === 'object') {
    const slim = {};
    for (const k of fields) {
      if (k === 'fourchette' && ad.marketAnalysis.valueRangeLow != null && ad.marketAnalysis.valueRangeHigh != null) {
        slim.valueRangeLow = ad.marketAnalysis.valueRangeLow;
        slim.valueRangeHigh = ad.marketAnalysis.valueRangeHigh;
      } else {
        const m = IA_TO_MARKET[k];
        if (m && ad.marketAnalysis[m] != null) slim[m] = ad.marketAnalysis[m];
      }
    }
    if (Object.keys(slim).length > 0) out.marketAnalysis = slim;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TXT normal (lisible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bloc TXT lisible d'une annonce, aligné sur le mode (Défaut / Personnalisé).
 * Le rendu est compacté : on n'affiche QUE les champs sélectionnés, et on
 * conserve le préfixe "===== ANNONCE X =====" pour la navigation humaine.
 *
 * `fields` = tableau de clés sélectionnées. null/undefined → toutes les clés.
 */
function toReadableBlock(ad, index, fields) {
  const selectedKeys = (Array.isArray(fields) && fields.length > 0) ? fields : ALL_FIELD_KEYS;

  // Calcule la longueur max de label pour aligner joliment les valeurs.
  const fieldDefs = selectedKeys.map((k) => FIELDS_BY_KEY[k]).filter(Boolean);
  const labelMax = fieldDefs.reduce((m, f) => Math.max(m, f.label.length), 0);

  const lines = [];
  lines.push(`===== ANNONCE ${index + 1} =====`);
  lines.push('');

  for (const f of fieldDefs) {
    const raw = f.get(ad);
    const labelPad = f.label.padEnd(labelMax, ' ');
    lines.push(`${labelPad} : ${_formatValue(f, raw)}`);
  }
  lines.push('');
  lines.push('========================');
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Texte raccourci — compression maximale SANS perte d'information
// ─────────────────────────────────────────────────────────────────────────────
//
// Stratégie : on sérialise chaque annonce sous la forme :
//   <champ>=<valeur>|<champ>=<valeur>|...
// où `|` est le séparateur par défaut. Pour rester robuste face aux valeurs
// contenant `|`, on utilise un encodage length-prefixed :
//   \x1F  : séparateur de champs (File Separator — non-imprimable, jamais
//            utilisé dans des données utilisateur)
//   \x1E  : préfixe d'échappement d'une valeur (Record Separator)
// On choisit des caractères ASCII de contrôle non-imprimables (0x1E, 0x1F)
// pour garantir un décodage non ambigu.
//
// Format d'une valeur échappée :
//   \x1E <longueur_decimale> ":" <octets bruts>
// Si la longueur est 0, la valeur est null/absente (champ présent mais vide).
//
// Format d'un champ :
//   <code_court>\x1F <valeur_échappée>
//
// En-tête de l'export (première ligne) :
//   ##SC## <version> \x1F <codes_courts_séparés_par_\x1F>
//
// Le décodeur peut ainsi vérifier la cohérence des codes courts et rejeter
// les fichiers corrompus ou générés par un schéma différent.

const SHORT_SEP_FIELD = '\x1F';   // File Separator (0x1F) entre champs
const SHORT_ESC = '\x1E';          // Record Separator (0x1E) début valeur échappée
const SHORT_SEP_LINE = '\x1D';     // Group Separator (0x1D) entre annonces (rare dans les données)
const SHORT_HEADER = '##SC##';     // marqueur d'en-tête
const SHORT_VERSION = '1';

function _shortEncodeValue(v) {
  if (v == null) return SHORT_ESC + '0:';
  let s;
  if (typeof v === 'string') s = v;
  else s = String(v);
  return SHORT_ESC + Buffer.byteLength(s, 'utf8') + ':' + s;
}

/**
 * Sérialisation Texte raccourci d'un lot d'annonces, alignée sur le mode choisi.
 *
 * Format :
 *   <en-tête> \n
 *   <annonce 1> \n
 *   <annonce 2> \n
 *   ...
 *
 * Annonce : <code1>\x1F<val1>\x1F<code2>\x1F<val2>... (sans séparateur en fin)
 *
 * Aucune information n'est perdue : tous les champs présents dans le TXT
 * (pour le même `fields`) sont encodés ici. Les valeurs reprennent le
 * formatage lisible utilisé dans le TXT pour rester humainement déchiffrables.
 */
function toShortText(ads, fields) {
  const selectedKeys = (Array.isArray(fields) && fields.length > 0) ? fields : ALL_FIELD_KEYS;
  const fieldDefs = selectedKeys.map((k) => FIELDS_BY_KEY[k]).filter(Boolean);
  const shorts = fieldDefs.map((f) => f.short).join(SHORT_SEP_FIELD);

  const lines = [`${SHORT_HEADER} ${SHORT_VERSION} ${SHORT_SEP_FIELD}${shorts}`];

  for (const ad of ads) {
    const parts = [];
    for (const f of fieldDefs) {
      const raw = f.get(ad);
      // Pour le short text : on conserve la valeur brute (pas de formatage
      // humain long type "4.5/5") pour gagner de la place. Le but est la
      // compression, pas la lisibilité parfaite.
      let v;
      if (raw == null) v = null;
      else if (typeof raw === 'string') v = raw;
      else v = String(raw);
      parts.push(f.short);
      parts.push(_shortEncodeValue(v));
    }
    lines.push(parts.join(SHORT_SEP_FIELD));
  }
  return lines.join(SHORT_SEP_LINE);
}

/**
 * Décodeur (utile pour les tests / debug). Renvoie { header, items }.
 * `items[i]` = { codeCourt: valeur, ... } trié par ordre de rencontre.
 *
 * Si la valeur fait 0 octet, la valeur correspondante est null.
 * L'en-tête est vérifié : si invalide, lance une erreur.
 */
function fromShortText(text) {
  if (typeof text !== 'string' || !text.startsWith(SHORT_HEADER + ' ')) {
    throw new Error('Texte raccourci invalide (en-tête manquant).');
  }
  const lines = text.split(SHORT_SEP_LINE);
  const headerLine = lines.shift();
  // headerLine : "##SC## 1 \x1Fcode1\x1Fcode2..."
  // split('\x1F') de "##SC## 1 \x1FI\x1FT..." donne :
  //   [0] = "##SC## 1 "  (la version est dans cette chaîne après le préfixe)
  //   [1] = "I" (1er code)
  //   [2] = "T" (2e code)
  //   ...
  // On extrait la version depuis [0] puis les codes depuis [1:].
  const headerParts = headerLine.split(SHORT_SEP_FIELD);
  if (headerParts.length < 2) throw new Error('En-tête Texte raccourci invalide.');
  const version = headerParts[0].slice(SHORT_HEADER.length + 1).trim();
  const codes = headerParts.slice(1);
  const items = [];
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(SHORT_SEP_FIELD);
    const obj = {};
    // parts[0] = 1er code, parts[1] = 1ère valeur, parts[2] = 2e code, parts[3] = 2e valeur, …
    for (let i = 0; i < codes.length && i * 2 + 1 < parts.length; i++) {
      const code = codes[i];
      const encoded = parts[i * 2 + 1];
      if (encoded == null) {
        obj[code] = null;
        continue;
      }
      if (!encoded.startsWith(SHORT_ESC)) {
        obj[code] = null;
        continue;
      }
      const rest = encoded.slice(1);
      const colonIdx = rest.indexOf(':');
      if (colonIdx < 0) {
        obj[code] = null;
        continue;
      }
      const lenStr = rest.slice(0, colonIdx);
      const len = parseInt(lenStr, 10);
      const value = rest.slice(colonIdx + 1);
      if (len === 0) {
        // Valeur nulle (champ présent mais vide) → null au décodage.
        obj[code] = null;
      } else if (Number.isFinite(len) && Buffer.byteLength(value, 'utf8') >= len) {
        obj[code] = value.slice(0, len);
      } else {
        obj[code] = null;
      }
    }
    items.push(obj);
  }
  return { version, codes, items };
}

module.exports = {
  DEFAULT_FIELDS,
  ALL_FIELD_KEYS,
  FIELD_CATEGORIES,
  FIELDS_BY_KEY,
  filterAdByFields,
  toReadableBlock,
  toShortText,
  fromShortText,
};
