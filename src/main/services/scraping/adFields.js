'use strict';

/**
 * adFields — extracteurs de champs pour les annonces Leboncoin.
 *
 * Module de SCRAPING PUR : aucun appel IA, aucun prompt, aucun LLM, aucun
 * fetch externe. Reçoit l'objet brut d'une annonce Leboncoin (extrait du HAR
 * ou du __NEXT_DATA__) et renvoie les champs structurés.
 *
 * CONVENTION STRICTE : tout champ non trouvé est `null` (jamais `0`, jamais
 * `''`, jamais une valeur inventée). Les booléens sont nullables (true | false
 * | null) pour distinguer les trois états : détecté OUI, détecté NON, indéterminé.
 */

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function firstNonNull(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    return v;
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
 * Extraction de la description depuis l'objet brut Leboncoin.
 * Renvoie une string ou null. Garantit qu'on ne renvoie JAMAIS un objet.
 *
 * La description peut apparaître sous plusieurs formes :
 *   - string direct : raw.body = "texte..."
 *   - objet {text, ...} : raw.body = { text: "texte...", ... }
 *   - string dans raw.description ou raw.text
 */
function extractDescription(raw) {
  if (!raw) return null;
  const candidates = [raw.body, raw.description, raw.text];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.length > 0) return c.text;
  }
  return null;
}

/**
 * Extraction du prix (valeur numérique).
 * Renvoie un nombre ou null.
 */
function extractPrice(raw) {
  if (!raw || raw.price == null) return null;
  if (typeof raw.price === 'number') return raw.price;
  if (Array.isArray(raw.price) && raw.price.length > 0) {
    const first = raw.price[0];
    if (first && typeof first === 'object' && first.value != null) {
      const n = parseFloat(first.value);
      if (!Number.isNaN(n)) return n;
    } else if (typeof first === 'number') return first;
    else if (typeof first === 'string') {
      const n = parseFloat(first);
      if (!Number.isNaN(n)) return n;
    }
  } else if (typeof raw.price === 'object' && raw.price.value != null) {
    const n = parseFloat(raw.price.value);
    if (!Number.isNaN(n)) return n;
  } else {
    const n = parseFloat(raw.price);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Extraction de la transaction : livraison + main propre, SÉPARÉS et INDÉPENDANTS.
 * Renvoie { livraison, mainPropre }.
 *   livraison  : true / false / null
 *   mainPropre : true / false / null
 */
function extractTransaction(raw) {
  const shippingVal = firstNonNull(
    raw?.has_option?.shipping,
    raw?.options?.shipping,
    raw?.has_shipping,
    raw?.shipping,
    raw?.delivery?.shipping,
    raw?.shipping_option?.shipping,
    raw?.shippingOptions,
    raw?.is_shippable,
    raw?.shippable,
    raw?.is_shipping,
    null
  );
  let livraison = _normalizeBool(shippingVal);

  if (livraison === null && Array.isArray(raw?.attributes)) {
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

  // Détection main propre via description.
  let mainPropre = null;
  const body = extractDescription(raw);
  if (body) {
    const lower = body.toLowerCase();
    if (/remise\s+en\s+main\s+propre|main\s+propre\s+uniquement|en\s+main\s+propre|retrait\s+sur\s+place|[àa]\s+venir\s+chercher|retrait\s+en\s+main\s+propre|pas\s+d.envoi|pas\s+d.exp[ée]dition|pas\s+de\s+livraison/.test(lower)) {
      mainPropre = true;
    }
  }
  // Si on n'a toujours pas d'info livraison mais on a des attributs, par défaut
  // pas de livraison (Leboncoin ne montre pas l'option d'envoi).
  if (livraison === null && Array.isArray(raw?.attributes) && raw.attributes.length > 0) {
    livraison = false;
  }
  // Si mainPropre est null mais livraison est explicitement false, alors
  // c'est implicitement de la remise en main propre.
  if (mainPropre === null && livraison === false) {
    mainPropre = true;
  }

  return { livraison, mainPropre };
}

/**
 * Extraction des likes / favoris.
 * Renvoie un nombre ou null (0 = Leboncoin affiche 0, null = info absente).
 */
function extractLikes(raw) {
  const likesRaw = firstNonNull(
    raw?.favorites_count,
    raw?.likes_count,
    raw?.nb_favorites,
    raw?.fav_count,
    raw?.favourites_count,
    raw?.likes,
    null
  );
  if (likesRaw == null) return null;
  const n = parseInt(likesRaw, 10);
  if (!Number.isNaN(n) && n >= 0) return n;
  return null;
}

/**
 * Extraction des photos : URLs.
 * Renvoie { count, urls }.
 */
function extractPhotos(raw) {
  let urls = [];
  if (Array.isArray(raw?.images?.urls)) {
    urls = raw.images.urls.filter((u) => typeof u === 'string' && u.trim() !== '');
  } else if (Array.isArray(raw?.images)) {
    urls = raw.images.filter((u) => typeof u === 'string' && u.trim() !== '');
  }
  return { count: urls.length, urls };
}

/**
 * Extraction du vendeur.
 * Renvoie { nom, type, id, note, urlProfil, ancienneteJours }.
 */
function extractSeller(raw) {
  const owner = raw?.owner || {};
  const seller = raw?.seller || {};
  const store = raw?.store || {};

  const nom = firstNonNull(
    typeof owner.name === 'string' ? owner.name : null,
    typeof owner.store_name === 'string' ? owner.store_name : null,
    typeof seller.name === 'string' ? seller.name : null,
    typeof store.name === 'string' ? store.name : null,
    raw?.owner_name,
    null
  );
  const id = firstNonNull(owner.user_id, owner.id, seller.id, store.id, raw?.user_id, null);

  const rawType = firstNonNull(owner.type, seller.type, store.type, raw?.user_type, null);
  let type = null;
  if (rawType) {
    const t = String(rawType).toLowerCase();
    if (t === 'pro' || t === 'professional') type = 'pro';
    else if (t === 'private' || t === 'particulier' || t === 'individual') type = 'particulier';
  }
  const isPro = type === 'pro' || store.is_pro === true || (owner.siren != null && owner.siren !== '');

  let note = null;
  const ratingVal = firstNonNull(owner.rating, owner.rating_average, owner.score, owner.ratingValue, seller.rating, raw?.seller_rating, raw?.rating, null);
  if (ratingVal !== null) {
    const n = parseFloat(ratingVal);
    if (!Number.isNaN(n) && n >= 0 && n <= 5) note = Math.round(n * 10) / 10;
  }

  const urlProfil = firstNonNull(owner.profile_url, owner.url, seller.url, store.url, null);

  let ancienneteJours = null;
  const memberSince = firstNonNull(owner.member_since, owner.registration_date, owner.since, seller.member_since, raw?.member_since, null);
  if (memberSince) {
    const d = new Date(memberSince);
    if (!Number.isNaN(d.getTime())) {
      ancienneteJours = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    }
  }

  return {
    nom,
    type: type || (isPro ? 'pro' : 'particulier'),
    isPro,
    id: id != null ? String(id) : null,
    note,
    urlProfil,
    ancienneteJours,
  };
}

/**
 * Extraction des dates : publication, modification.
 * Renvoie { publication, modification }.
 */
function extractDates(raw) {
  const publication = firstNonNull(
    raw?.first_publication_date,
    raw?.publication_date,
    raw?.index_date,
    raw?.date,
    raw?.created_at,
    null
  );
  const modification = firstNonNull(
    raw?.last_update_date,
    raw?.modification_date,
    raw?.updated_at,
    raw?.refresh_date,
    null
  );
  return { publication, modification };
}

/**
 * Extraction de l'État déclaré du produit.
 * Renvoie l'état tel que déclaré par le vendeur dans les attributs structurés
 * (champ "condition" / "etat" / "état" dans le tableau attributes[]).
 * Renvoie null si non trouvé.
 */
function extractCondition(raw) {
  if (Array.isArray(raw?.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      if (key === 'condition' || key === 'etat' || key === 'état') {
        const v = firstNonNull(attr.value, attr.label, null);
        if (v != null && v !== '') return String(v);
      }
    }
  }
  return null;
}

module.exports = {
  firstDefined,
  firstNonNull,
  extractDescription,
  extractPrice,
  extractTransaction,
  extractLikes,
  extractPhotos,
  extractSeller,
  extractDates,
  extractCondition,
};
