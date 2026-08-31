'use strict';

/**
 * adFields — extracteurs de champs enrichis pour les annonces Leboncoin.
 *
 * Centralise toutes les fonctions d'extraction défensive (vendeur, dates,
 * attributs produit, photos, détection de mots-clés dans la description) en
 * un module pur, facile à tester et à réutiliser depuis n'importe quel
 * composant (pipeline, IPC, adAnalyzer).
 *
 * Conventions :
 *  - Tout champ non trouvé renvoie `null` (jamais `0`, jamais `''`, jamais
 *    de valeur par défaut arbitraire — l'objectif est l'exactitude des
 *    données, pas l'esthétique).
 *  - Les fonctions prennent l'objet brut `raw` de Leboncoin (extrait du HAR
 *    ou du __NEXT_DATA__) et renvoient un objet typé.
 *  - Les booléens sont nullables (true | false | null) pour distinguer les
 *    trois états : détecté OUI, détecté NON, indéterminé.
 */

const { cleanText } = require('../../utils/helpers');

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function firstNonNull(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '' && !Number.isNaN(v)) return v;
  }
  return null;
}

function _normalizeBool(val) {
  if (val === true || val === 'true' || val === 1 || val === '1') return true;
  if (val === false || val === 'false' || val === 0 || val === '0') return false;
  if (val && typeof val === 'object' && 'value' in val) return _normalizeBool(val.value);
  if (val && typeof val === 'object' && 'shipping' in val) return _normalizeBool(val.shipping);
  return null;
}

/**
 * Code postal → département français (2 ou 3 premiers caractères selon
 * Corse 2A/2B). Renvoie null si le code postal est invalide.
 */
function zipcodeToDepartment(zipcode) {
  if (!zipcode || typeof zipcode !== 'string') return null;
  const z = zipcode.trim();
  if (!/^\d{5}$/.test(z)) return null;
  // Corse : 2A (département 20A) et 2B (département 20B)
  if (z.startsWith('20') && (z[2] === '0' || z[2] === '1' || z[2] === '2' || z[2] === '3' || z[2] === '4' || z[2] === '5' || z[2] === '6' || z[2] === '7' || z[2] === '8' || z[2] === '9')) {
    return z.startsWith('20') && (z >= '20000' && z <= '20190') ? '2A' : (z >= '20200' && z <= '20290') ? '2B' : z.slice(0, 2);
  }
  // DOM-TOM : 97x / 98x → 3 chiffres
  if (z.startsWith('97') || z.startsWith('98')) return z.slice(0, 3);
  return z.slice(0, 2);
}

/**
 * Extraction complète des informations vendeur.
 * Renvoie { name, storeName, type, isPro, rating, ratingCount, profileUrl,
 *   id, accountAgeDays, hasRating }
 * Toutes les valeurs sont null si non trouvées (jamais inventées).
 */
function extractSeller(raw) {
  const owner = raw.owner || {};
  const seller = raw.seller || {};
  const store = raw.store || {};

  const name = firstNonNull(
    owner.name,
    owner.store_name,
    seller.name,
    store.name,
    raw.owner_name,
    null
  );
  const storeName = firstNonNull(store.name, owner.store_name, null);
  const id = firstNonNull(owner.user_id, owner.id, seller.id, store.id, raw.user_id, null);

  // Type de vendeur : "pro" / "professional" / "particulier" / "private"
  const rawType = firstNonNull(owner.type, seller.type, store.type, raw.user_type, null);
  let type = null;
  if (rawType) {
    const t = String(rawType).toLowerCase();
    if (t === 'pro' || t === 'professional') type = 'pro';
    else if (t === 'private' || t === 'particulier' || t === 'individual') type = 'particulier';
  }
  const siren = owner.siren;
  const hasSiren = siren != null && siren !== '';
  const isPro = type === 'pro' || store.is_pro === true || hasSiren;

  // Note vendeur
  let rating = null;
  const ratingVal = firstNonNull(
    owner.rating,
    owner.rating_average,
    owner.score,
    owner.ratingValue,
    seller.rating,
    raw.seller_rating,
    raw.rating,
    null
  );
  if (ratingVal !== null) {
    const n = parseFloat(ratingVal);
    if (!Number.isNaN(n) && n >= 0 && n <= 5) rating = Math.round(n * 10) / 10;
  }

  // Nombre d'avis
  let ratingCount = null;
  const countVal = firstNonNull(
    owner.nb_ratings,
    owner.ratings_count,
    owner.rating_count,
    owner.nbReviews,
    owner.review_count,
    seller.nb_ratings,
    raw.seller_rating_count,
    raw.nb_ratings,
    null
  );
  if (countVal !== null) {
    const c = parseInt(countVal, 10);
    if (!Number.isNaN(c) && c >= 0) ratingCount = c;
  }

  const profileUrl = firstNonNull(owner.profile_url, owner.url, seller.url, store.url, null);
  // Ancienneté du compte : date d'inscription moins now
  const memberSince = firstNonNull(owner.member_since, owner.registration_date, owner.since, seller.member_since, raw.member_since, null);
  let accountAgeDays = null;
  if (memberSince) {
    const d = new Date(memberSince);
    if (!Number.isNaN(d.getTime())) {
      accountAgeDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }

  return {
    name,
    storeName,
    type: type || (isPro ? 'pro' : 'particulier'),
    isPro,
    rating,
    ratingCount,
    profileUrl,
    id: id != null ? String(id) : null,
    accountAgeDays,
    siren: hasSiren ? String(siren) : null,
  };
}

/**
 * Extraction des dates d'annonce. Renvoie { publication, modification,
 *   status, statusLabel } en ISO string ou null.
 */
function extractDates(raw) {
  const publication = firstNonNull(
    raw.first_publication_date,
    raw.publication_date,
    raw.index_date,
    raw.date,
    raw.created_at,
    null
  );
  const modification = firstNonNull(
    raw.last_update_date,
    raw.modification_date,
    raw.updated_at,
    raw.refresh_date,
    null
  );
  const status = firstNonNull(raw.status, raw.ad_status, raw.state, null);
  return {
    publication,
    modification,
    status,
    statusLabel: status ? String(status).toLowerCase() : null,
  };
}

/**
 * Extraction des attributs structurés du produit depuis le tableau
 * `attributes` (clé/valeur). Renvoie un objet { brand, model, color, size,
 *   capacity, year, material, condition, warranty, invoice, ... } adapté
 * dynamiquement aux attributs trouvés.
 *
 * Les libellés Leboncoin varient (key normalisée en minuscule). On expose
 * une API générique `attributes` (ob brut) + un sous-ensemble de champs
 * pratiques pour les usages courants.
 */
function extractAttributes(raw) {
  const generic = {};
  const mapped = {
    brand: null, model: null, color: null, size: null, capacity: null,
    year: null, material: null, condition: null, warranty: null, invoice: null,
    reference: null, type: null, garantie: null, facture: null,
  };

  if (Array.isArray(raw.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase().trim();
      const label = String(attr.label || attr.name || attr.key || '').trim();
      const value = attr.value;

      // Champs mappés (sous-ensemble)
      if (key === 'brand' || key === 'marque') mapped.brand = firstNonNull(value, mapped.brand);
      else if (key === 'model' || key === 'modele' || key === 'modèle') mapped.model = firstNonNull(value, mapped.model);
      else if (key === 'color' || key === 'couleur') mapped.color = firstNonNull(value, mapped.color);
      else if (key === 'size' || key === 'taille') mapped.size = firstNonNull(value, mapped.size);
      else if (key === 'capacity' || key === 'capacite' || key === 'capacité' || key === 'storage' || key === 'stockage') mapped.capacity = firstNonNull(value, mapped.capacity);
      else if (key === 'year' || key === 'annee' || key === 'année') mapped.year = firstNonNull(value, mapped.year);
      else if (key === 'material' || key === 'matiere' || key === 'matière') mapped.material = firstNonNull(value, mapped.material);
      else if (key === 'condition' || key === 'etat' || key === 'état') mapped.condition = firstNonNull(value, mapped.condition);
      else if (key === 'warranty' || key === 'garantie') mapped.warranty = firstNonNull(value, mapped.warranty);
      else if (key === 'invoice' || key === 'facture') mapped.invoice = firstNonNull(value, mapped.invoice);
      else if (key === 'reference' || key === 'ref' || key === 'référence') mapped.reference = firstNonNull(value, mapped.reference);
      else if (key === 'type' || key === 'product_type' || key === 'type_de_produit') mapped.type = firstNonNull(value, mapped.type);

      // Objet brut : on garde aussi la clé originale pour ne rien perdre
      if (key && (label || value != null)) {
        generic[key] = { label: label || key, value: value != null ? String(value) : null };
      }
    }
  }

  // Garantie / facture : booléens si déclarés en attributs
  if (mapped.warranty != null) {
    const w = String(mapped.warranty).toLowerCase();
    mapped.garantie = /^(oui|yes|1|true)$/i.test(w) || /\boui\b/i.test(mapped.warranty);
  }
  if (mapped.invoice != null) {
    const f = String(mapped.invoice).toLowerCase();
    mapped.facture = /^(oui|yes|1|true)$/i.test(f) || /\boui\b/i.test(mapped.invoice);
  }

  return { mapped, generic };
}

/**
 * Extraction des informations de prix.
 * Renvoie { valeur, devise, original, negociable, priceLabel }.
 * `valeur` est un nombre ou null ; `original` est la valeur précédente si
 * une baisse est détectable, sinon null.
 */
function extractPrice(raw) {
  let valeur = null;
  if (raw.price != null) {
    if (typeof raw.price === 'number') valeur = raw.price;
    else if (Array.isArray(raw.price) && raw.price.length > 0) {
      // Leboncoin expose parfois le prix comme un tableau d'objets [{value,currency}]
      const first = raw.price[0];
      if (first && typeof first === 'object' && first.value != null) {
        const n = parseFloat(first.value);
        if (!Number.isNaN(n)) valeur = n;
      } else if (typeof first === 'number') {
        valeur = first;
      } else if (typeof first === 'string') {
        const n = parseFloat(first);
        if (!Number.isNaN(n)) valeur = n;
      }
    } else if (typeof raw.price === 'object' && raw.price.value != null) {
      const n = parseFloat(raw.price.value);
      if (!Number.isNaN(n)) valeur = n;
    } else {
      const n = parseFloat(raw.price);
      if (!Number.isNaN(n)) valeur = n;
    }
  }
  const devise = firstNonNull(raw.price?.currency, raw.currency, raw.price_currency, raw.price?.[0]?.currency, 'EUR');
  let original = null;
  const rawOriginal = firstNonNull(raw.price?.original, raw.original_price, raw.previous_price, null);
  if (rawOriginal != null) {
    const n = parseFloat(rawOriginal);
    if (!Number.isNaN(n) && valeur != null && n > valeur) original = n;
  }
  const negociable = _normalizeBool(firstNonNull(raw.negociable, raw.price_negotiable, raw.is_negotiable, null));
  return { valeur, devise, original, negociable };
}

/**
 * Extraction des informations de transaction : livraison + remise en main
 * propre + mode de remise + libellé transporteur. Champs null si
 * indéterminés (jamais false par défaut — voir extractDeliveryInfo
 * original dans le pipeline pour la stratégie détaillée).
 */
function extractTransaction(raw) {
  const shippingVal = firstNonNull(
    raw.has_option?.shipping,
    raw.options?.shipping,
    raw.has_shipping,
    raw.shipping,
    raw.delivery?.shipping,
    raw.shipping_option?.shipping,
    raw.shippingOptions,
    raw.is_shippable,
    raw.shippable,
    raw.is_shipping,
    null
  );
  let livraison = _normalizeBool(shippingVal);

  if (livraison === null && Array.isArray(raw.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      const val = attr.value;
      if (key === 'shippable' || key === 'is_shippable' || key === 'shipping' || key === 'is_shipping') {
        livraison = _normalizeBool(val);
        if (livraison !== null) break;
      }
    }
  }

  const deliveryOption = firstNonNull(
    raw.delivery?.delivery_option,
    raw.delivery_option,
    raw.delivery?.option,
    raw.shipping_option?.delivery_option,
    null
  );

  let attrDeliveryLabel = null;
  if (Array.isArray(raw.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      if (key === 'shipping_label' || key === 'delivery_mode' || key === 'carrier') {
        attrDeliveryLabel = firstNonNull(attr.value, attrDeliveryLabel);
      }
    }
  }

  const deliveryLabel = firstNonNull(
    deliveryOption,
    raw.delivery?.carrier,
    raw.delivery?.label,
    raw.shipping_option?.carrier,
    raw.shipping_option?.label,
    attrDeliveryLabel,
    null
  );
  if (livraison === null && deliveryLabel) livraison = true;

  // Détection main propre via description
  if (livraison === null) {
    const body = firstNonNull(raw.body, raw.description, raw.text, null);
    if (body && typeof body === 'string') {
      const lowerBody = body.toLowerCase();
      if (/remise\s+en\s+main\s+propre|main\s+propre\s+uniquement|pas\s+d['\s]+envoi|retrait\s+uniquement|retrait\s+en\s+main\s+propre/.test(lowerBody)) {
        livraison = false;
      }
    }
  }
  if (livraison === null && Array.isArray(raw.attributes) && raw.attributes.length > 0) {
    livraison = false;
  }

  const mainPropre = livraison === false ? true : (livraison === true ? false : null);
  let mode = 'inconnu';
  if (livraison === true) mode = 'livraison';
  else if (livraison === false) mode = 'main_propre';

  return { livraison, mainPropre, mode, deliveryLabel };
}

/**
 * Extraction des statistiques publiques : likes / favoris / vues.
 * Renvoie { likes, vues }. Toujours null si non trouvées (0 = Leboncoin a
 * affiché 0 ; null = info indisponible).
 */
function extractStats(raw) {
  let likes = null;
  const likesRaw = firstNonNull(raw.favorites_count, raw.likes_count, raw.nb_favorites, raw.fav_count, raw.favourites_count, raw.likes, null);
  if (likesRaw != null) {
    const n = parseInt(likesRaw, 10);
    if (!Number.isNaN(n) && n >= 0) likes = n;
  }

  let vues = null;
  const vuesRaw = firstNonNull(raw.views_count, raw.nb_views, raw.view_count, raw.views, raw.page_views, null);
  if (vuesRaw != null) {
    const n = parseInt(vuesRaw, 10);
    if (!Number.isNaN(n) && n >= 0) vues = n;
  }
  return { likes, vues };
}

/**
 * Extraction des photos : URLs originales et miniatures si distinguables.
 * Renvoie { count, urls, thumbnails, main }.
 */
function extractPhotos(raw) {
  let urls = [];
  let thumbnails = [];
  if (Array.isArray(raw.images?.urls)) urls = raw.images.urls.filter((u) => typeof u === 'string' && u.trim() !== '');
  else if (Array.isArray(raw.images)) urls = raw.images.filter((u) => typeof u === 'string' && u.trim() !== '');
  if (Array.isArray(raw.images?.thumbnails)) thumbnails = raw.images.thumbnails.filter((u) => typeof u === 'string' && u.trim() !== '');
  // Fallback : si pas de thumbnails explicites, on dérive depuis les URLs
  if (thumbnails.length === 0 && urls.length > 0 && urls[0].includes('//')) {
    thumbnails = urls.map((u) => u);
  }
  return {
    count: urls.length,
    urls,
    thumbnails,
    main: urls.length > 0 ? urls[0] : null,
    mainThumbnail: thumbnails.length > 0 ? thumbnails[0] : null,
  };
}

/**
 * Extraction et nettoyage de la description.
 * Renvoie { originale, nettoyee, longueur }.
 * `originale` : texte brut (peut contenir sauts de ligne). `nettoyee` :
 * version avec sauts de ligne normalisés et espaces en double supprimés.
 * JAMAIS de résumé — la description originale est conservée telle quelle.
 */
function extractDescription(raw) {
  const originale = firstNonNull(raw.body, raw.description, raw.text, null);
  if (originale == null) return { originale: null, nettoyee: null, longueur: 0 };
  const nettoyee = cleanText(originale);
  return {
    originale: typeof originale === 'string' ? originale : null,
    nettoyee,
    longueur: typeof originale === 'string' ? originale.length : 0,
  };
}

/**
 * Détection par analyse de texte (regex) des informations contextuelles
 * présentes dans la description : négociable, prix ferme, facture,
 * garantie, état, échange accepté/refusé, urgence, accessoires, etc.
 *
 * IMPORTANT : on NE CONFOND PAS une mention textuelle avec une certitude
 * structurée. On utilise `confirm=true` quand la mention est sans ambiguïté
 * ("prix ferme", "non négociable"), `confirm=false` quand elle est
 * suggestive ("possible d'échanger" = incertain), `null` si aucun marqueur
 * trouvé.
 *
 * Chaque fonction renvoie true / false / null. La sémantique de `true` :
 * "déclaré oui dans la description". `false` : "déclaré non dans la
 * description". `null` : "pas d'information".
 */
const DESC_PATTERNS = {
  negociable: {
    yes: [/\bn[ée]gociable\b/i, /\b[àa]\s+d[ée]battre\b/i, /\bn[ée]gocier\b/i, /\bfaire\s+une?\s+offre\b/i, /\bfaire\s+offre\b/i, /\bprix\s+[àa]\s+d[ée]battre\b/i, /\bdiscutable\b/i],
    no: [/\bprix\s+ferme\b/i, /\bnon\s+n[ée]gociable\b/i, /\bpas\s+n[ée]gociable\b/i, /\bpas\s+de\s+n[ée]gociation\b/i, /\bnon\s+nego\b/i],
  },
  facture: {
    yes: [/\bavec\s+facture\b/i, /\bfacture\s+(?:fournie|disponible|présente|incluse|d['\s]origine|achats?)\b/i, /\bticket\s+de\s+caisse\b/i, /\b(?:disponible|remise)\s+facture\b/i],
    no: [/\bsans\s+facture\b/i, /\bpas\s+de\s+facture\b/i],
  },
  garantie: {
    yes: [/\bgarantie\b/i, /\bsous\s+garantie\b/i, /\bencore\s+garanti\b/i, /\bgarantie\s+(?:constructeur|fabricant|1\s+an|2\s+ans)\b/i],
    no: [/\bpas\s+de\s+garantie\b/i, /\bsans\s+garantie\b/i, /\bgarantie\s+expir[eé]e?\b/i],
  },
  boiteOrigine: {
    yes: [/\bbo[iî]te\s+d['\s]origine\b/i, /\bemballage\s+d['\s]origine\b/i, /\bavec\s+bo[iî]te\b/i, /\bavec\s+emballage\b/i],
    no: [/\bsans\s+bo[iî]te\b/i, /\bsans\s+emballage\b/i],
  },
  accessoires: {
    yes: [/\bavec\s+accessoires\b/i, /\btous\s+les\s+accessoires\b/i, /\baccessoires\s+fournis\b/i],
  },
  etatNeuf: {
    yes: [/\bneuf\b/i, /\bjamais\s+utilis[ée]\b/i, /\bsous\s+emballage\b/i, /\bbrand\s+new\b/i],
  },
  tresBonEtat: {
    yes: [/\btrès\s+bon\s+[ée]tat\b/i, /\bcomme\s+neuf\b/i, /\bnickel\b/i, /\bimpeccable\b/i],
  },
  bonEtat: {
    yes: [/\bbon\s+[ée]tat\b/i, /\ben\s+bon\s+[ée]tat\b/i],
  },
  etatCorrect: {
    yes: [/\b[ée]tat\s+correct\b/i, /\b[ée]tat\s+moyen\b/i, /\busure[s]?\s+normales?\b/i],
  },
  aReparer: {
    yes: [/\b[àa]\s+r[ée]parer\b/i, /\bhs\b/i, /\bnon\s+fonctionnel\b/i, /\bne\s+fonctionne\s+pas\b/i, /\bpour\s+pi[eè]ces\b/i, /\ben\s+panne\b/i],
  },
  fonctionne: {
    yes: [/\bfonctionne\s+(?:parfaitement|tres?\s+bien|nickel|correctement|normalement)\b/i, /\bparfaitement\s+fonctionnel\b/i],
    no: [/\bne\s+fonctionne\s+pas\b/i, /\bnon\s+fonctionnel\b/i, /\bhs\b/i, /\ben\s+panne\b/i],
  },
  urgent: {
    yes: [/\burgent\b/i, /\bvends?\s+vite\b/i, /\b[àa]\s+vendre\s+rapidement\b/i, /\bpart\s+imm[ée]diate\b/i],
  },
  echangeAccepte: {
    yes: [/\b[ée]change[s]?\s+(?:accept[ée]|possible|oui)\b/i, /\b[ée]change\s+contre\b/i],
    no: [/\bpas\s+d['\s][ée]change\b/i, /\b[ée]change\s+(?:refus[ée]|non)\b/i, /\bsans\s+[ée]change\b/i],
  },
  remiseEnMainPropre: {
    yes: [/\bremise\s+en\s+main\s+propre\b/i, /\ben\s+main\s+propre\b/i, /\bretrait\s+sur\s+place\b/i, /\b[àa]\s+venir\s+chercher\b/i],
  },
  livraisonPossible: {
    yes: [/\blivraison\s+possible\b/i, /\bje\s+peux\s+livrer\b/i, /\bexp[ée]dition\s+possible\b/i, /\benvoi\s+possible\b/i, /\bje\s+peux\s+envoyer\b/i],
    no: [/\bpas\s+d['\s]envoi\b/i, /\bpas\s+de\s+livraison\b/i, /\bsans\s+livraison\b/i],
  },
};

function detectInDescription(description) {
  const out = {};
  if (!description || typeof description !== 'string') {
    // Tous les champs à null
    for (const k of Object.keys(DESC_PATTERNS)) out[k] = null;
    return out;
  }
  for (const [key, patterns] of Object.entries(DESC_PATTERNS)) {
    let val = null;
    // On teste d'abord les NON (les plus forts sémantiquement) puis les OUI
    if (patterns.no && patterns.no.some((p) => p.test(description))) {
      val = false;
    } else if (patterns.yes && patterns.yes.some((p) => p.test(description))) {
      val = true;
    }
    out[key] = val;
  }
  return out;
}

/**
 * Détermine l'état du produit détecté dans la description. Hiérarchie :
 * neuf > très bon > bon > correct > à réparer > HS.
 * Renvoie { etat, etatLabel } ou { etat: null } si indéterminé.
 */
function inferCondition(detected) {
  if (!detected) return { etat: null, etatLabel: null };
  if (detected.etatNeuf === true) return { etat: 'neuf', etatLabel: 'Neuf' };
  if (detected.tresBonEtat === true) return { etat: 'tres_bon', etatLabel: 'Très bon état' };
  if (detected.bonEtat === true) return { etat: 'bon', etatLabel: 'Bon état' };
  if (detected.etatCorrect === true) return { etat: 'correct', etatLabel: 'État correct' };
  if (detected.aReparer === true) return { etat: 'a_reparer', etatLabel: 'À réparer' };
  return { etat: null, etatLabel: null };
}

/**
 * Calcule les métadonnées de qualité du scraping pour une annonce donnée.
 * Compte les champs renseignés (non-null) sur un ensemble de référence,
 * renvoie { statut, champsRecuperes, champsTotal, champsIndisponibles,
 *   champsManquants[] }.
 *
 * @param {object} normalized  annonce déjà normalisée (par normalizeAd)
 * @param {string[]} trackedFields  noms de champs à suivre pour le score
 */
function scraperQuality(normalized, trackedFields = [
  'id', 'title', 'prix.valeur', 'description.originale', 'url',
  'city', 'zipcode', 'category', 'dates.publication', 'dates.scraping',
  'vendeur.nom', 'vendeur.note', 'vendeur.nombreAvis',
  'transaction.livraison', 'transaction.mainPropre',
  'statistiques.likes', 'statistiques.vues',
  'prix.negociable', 'produit.brand', 'produit.model',
  'photos.count',
]) {
  let ok = 0;
  const manquants = [];
  for (const path of trackedFields) {
    const parts = path.split('.');
    let val = normalized;
    for (const p of parts) val = val && val[p];
    if (val != null && val !== '') ok++;
    else manquants.push(path);
  }
  const total = trackedFields.length;
  let statut = 'partial';
  if (ok === total) statut = 'success';
  else if (ok < total / 2) statut = 'error';
  return {
    statut,
    champsRecuperes: ok,
    champsTotal: total,
    champsIndisponibles: total - ok,
    champsManquants: manquants,
  };
}

module.exports = {
  firstDefined,
  firstNonNull,
  zipcodeToDepartment,
  extractSeller,
  extractDates,
  extractAttributes,
  extractPrice,
  extractTransaction,
  extractStats,
  extractPhotos,
  extractDescription,
  detectInDescription,
  inferCondition,
  scraperQuality,
};