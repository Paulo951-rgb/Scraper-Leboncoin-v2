'use strict';

/**
 * adFields — extracteurs de champs pour les annonces Leboncoin.
 *
 * Module de SCRAPING PUR : aucun appel IA, aucun prompt, aucun LLM. Reçoit
 * l'objet brut d'une annonce Leboncoin (extrait du HAR ou du __NEXT_DATA__)
 * et renvoie les champs structurés demandés par l'utilisateur.
 *
 * CONVENTION STRICTE : tout champ non trouvé est `null` (jamais `0`, jamais
 * `''`, jamais une valeur inventée). Les booléens sont nullables (true | false
 * | null) pour distinguer les trois états : détecté OUI, détecté NON, indéterminé.
 *
 * CHAMPS EXTRAITS (structure finale de l'annonce normalisée) :
 *   GÉNÉRAL: id, title, url, category, subCategory, price (valeur + devise),
 *            city, zipcode, department
 *   VENDEUR: nom, type, id, note, nombreAvis, urlProfil, ancienneteJours
 *   TRANSACTION: livraison, mainPropre (séparés), transporteur
 *   STATISTIQUES: likes (0 si Leboncoin affiche 0, null si info absente)
 *   DATES: publication, modification, scraping (ISO)
 *   PRODUIT: etat (État déclaré) — uniquement ce champ
 *   PHOTOS: count, urls, principale
 *   DESCRIPTION: originale (string), longueur
 *   SCRAPING: statut qualité, champs récupérés, manquants
 *
 * CHAMPS VOLONTAIREMENT NON EXTRAITS (supprimés) : negociable, facture,
 * garantie, echangeAccepte, urgent, vues, marque, modele, couleur, taille,
 * capacite, annee, matiere, etatDetecte, reference. Ces données n'apparaissent
 * NI dans les exports, NI dans l'UI, NI dans les filtres, NI dans les tris.
 */

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

/**
 * firstNonNull : comme firstDefined mais exclut aussi les chaînes vides et NaN.
 * Utilisé pour les champs numériques (note, nombre d'avis...).
 */
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
 * Code postal → département français. Renvoie null si invalide.
 * Gère Corse 2A/2B et DOM-TOM 97x/98x (3 chiffres).
 */
function zipcodeToDepartment(zipcode) {
  if (!zipcode || typeof zipcode !== 'string') return null;
  const z = zipcode.trim();
  if (!/^\d{5}$/.test(z)) return null;
  // DOM-TOM : 97x / 98x → 3 chiffres
  if (z.startsWith('97') || z.startsWith('98')) return z.slice(0, 3);
  // Corse : 2A (20000-20190) et 2B (20200-20290)
  if (z >= '20000' && z <= '20190') return '2A';
  if (z >= '20200' && z <= '20290') return '2B';
  return z.slice(0, 2);
}

/**
 * Extraction de la description depuis l'objet brut Leboncoin.
 *
 * Renvoie un objet { originale, longueur }.
 *
 * La description peut apparaître sous plusieurs formes dans l'API :
 *   - string direct : raw.body = "texte..."
 *   - objet {text, ...} : raw.body = { text: "texte...", ... }
 *   - string dans raw.description ou raw.text
 *
 * IMPORTANT : la fonction GARANTIT que `originale` est une string valide
 * (jamais un objet). Si la valeur trouvée n'est pas une string ou un objet
 * {text: string}, on renvoie null. C'est la correction du bug "[object Object]"
 * qui apparaissait dans le TXT quand `raw.body` était un objet.
 *
 * `longueur` est la longueur de la string originale (0 si absente).
 */
function extractDescription(raw) {
  if (!raw) return { originale: null, longueur: 0 };
  const candidates = [raw.body, raw.description, raw.text];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return { originale: c, longueur: c.length };
    }
    if (c && typeof c === 'object' && typeof c.text === 'string' && c.text.length > 0) {
      return { originale: c.text, longueur: c.text.length };
    }
  }
  return { originale: null, longueur: 0 };
}

/**
 * Extraction du prix (valeur numérique séparée du symbole €).
 * Renvoie { valeur, devise }.
 */
function extractPrice(raw) {
  let valeur = null;
  if (raw && raw.price != null) {
    if (typeof raw.price === 'number') {
      valeur = raw.price;
    } else if (Array.isArray(raw.price) && raw.price.length > 0) {
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
  const devise = firstNonNull(raw?.price?.currency, raw?.currency, raw?.price_currency, raw?.price?.[0]?.currency, 'EUR');
  return { valeur, devise };
}

/**
 * Extraction de la transaction : livraison + main propre, SÉPARÉS et INDÉPENDANTS.
 *
 * Renvoie { livraison, mainPropre, transporteur }.
 *   livraison  : true / false / null
 *   mainPropre : true / false / null
 *   transporteur: libellé humain du transporteur (Colissimo, Mondial Relay...) ou null
 *
 * Les deux booléens sont totalement indépendants (l'utilisateur peut avoir
 * livraison=OUI et mainPropre=OUI en même temps).
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

  // Libellé transporteur
  const deliveryOption = firstNonNull(
    raw?.delivery?.delivery_option,
    raw?.delivery_option,
    raw?.delivery?.option,
    raw?.shipping_option?.delivery_option,
    null
  );
  let attrDeliveryLabel = null;
  if (Array.isArray(raw?.attributes)) {
    for (const attr of raw.attributes) {
      if (!attr || typeof attr !== 'object') continue;
      const key = String(attr.key || attr.name || '').toLowerCase();
      if (key === 'shipping_label' || key === 'delivery_mode' || key === 'carrier') {
        attrDeliveryLabel = firstNonNull(attr.value, attrDeliveryLabel);
      }
    }
  }
  const transporteur = firstNonNull(
    deliveryOption,
    raw?.delivery?.carrier,
    raw?.delivery?.label,
    raw?.shipping_option?.carrier,
    raw?.shipping_option?.label,
    attrDeliveryLabel,
    null
  );
  // Un libellé de transporteur (Colissimo, Mondial Relay...) indique que
  // Leboncoin propose effectivement une option d'envoi.
  if (livraison === null && transporteur) {
    livraison = true;
  }

  // Détection main propre via description. La description peut indiquer
  // explicitement que le vendeur ne fait que du pickup (pas d'envoi, retrait
  // sur place, à venir chercher...).
  let mainPropre = null;
  const body = extractDescription(raw).originale;
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

  return { livraison, mainPropre, transporteur };
}

/**
 * Extraction des statistiques publiques : likes / favoris uniquement.
 * Renvoie { likes }. Toujours null si non trouvées (0 = Leboncoin affiche 0).
 */
function extractStats(raw) {
  let likes = null;
  const likesRaw = firstNonNull(
    raw?.favorites_count,
    raw?.likes_count,
    raw?.nb_favorites,
    raw?.fav_count,
    raw?.favourites_count,
    raw?.likes,
    null
  );
  if (likesRaw != null) {
    const n = parseInt(likesRaw, 10);
    if (!Number.isNaN(n) && n >= 0) likes = n;
  }
  return { likes };
}

/**
 * Extraction des photos : URLs + photo principale.
 * Renvoie { count, urls, principale }.
 */
function extractPhotos(raw) {
  let urls = [];
  if (Array.isArray(raw?.images?.urls)) {
    urls = raw.images.urls.filter((u) => typeof u === 'string' && u.trim() !== '');
  } else if (Array.isArray(raw?.images)) {
    urls = raw.images.filter((u) => typeof u === 'string' && u.trim() !== '');
  }
  return {
    count: urls.length,
    urls,
    principale: urls.length > 0 ? urls[0] : null,
  };
}

/**
 * Extraction du vendeur.
 * Renvoie { nom, type, id, note, nombreAvis, urlProfil, ancienneteJours, isPro }.
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
  const hasSiren = owner.siren != null && owner.siren !== '';
  const isPro = type === 'pro' || store.is_pro === true || hasSiren;

  let note = null;
  const ratingVal = firstNonNull(owner.rating, owner.rating_average, owner.score, owner.ratingValue, seller.rating, raw?.seller_rating, raw?.rating, null);
  if (ratingVal !== null) {
    const n = parseFloat(ratingVal);
    if (!Number.isNaN(n) && n >= 0 && n <= 5) note = Math.round(n * 10) / 10;
  }

  let nombreAvis = null;
  const countVal = firstNonNull(owner.nb_ratings, owner.ratings_count, owner.rating_count, owner.nbReviews, owner.review_count, seller.nb_ratings, raw?.seller_rating_count, raw?.nb_ratings, null);
  if (countVal !== null) {
    const c = parseInt(countVal, 10);
    if (!Number.isNaN(c) && c >= 0) nombreAvis = c;
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
    nombreAvis,
    urlProfil,
    ancienneteJours,
  };
}

/**
 * Extraction des dates : publication, modification.
 * La date de scraping est gérée séparément (injectée au moment de la normalisation).
 * Renvoie { publication, modification, statut }.
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
  const statut = firstNonNull(raw?.status, raw?.ad_status, raw?.state, null);
  return { publication, modification, statut };
}

/**
 * Extraction de l'État déclaré du produit.
 * Renvoie l'état tel que déclaré par le vendeur dans les attributs structurés
 * (champ "condition" / "etat" / "état" dans le tableau attributes[]).
 * Renvoie null si non trouvé. On ne DÉDUIT PAS l'état — on ne récupère que
 * ce que le vendeur a explicitement déclaré.
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

/**
 * Calcule la qualité du scraping pour une annonce normalisée.
 * Compte les champs effectivement renseignés (non-null) sur un ensemble de
 * référence ADAPTÉ À LA NOUVELLE STRUCTURE MINIMALE. Ne référence QUE des
 * champs qui existent réellement dans la structure finale.
 *
 * Renvoie { statut, champsRecuperes, champsTotal, champsIndisponibles,
 *   champsManquants[] }.
 */
function scraperQuality(normalized, trackedFields = [
  'id', 'title', 'url', 'category',
  'prix', 'description.originale',
  'city', 'zipcode', 'department',
  'vendeur.nom', 'vendeur.note', 'vendeur.nombreAvis',
  'transaction.livraison', 'transaction.mainPropre',
  'statistiques.likes',
  'dates.publication', 'dates.scraping',
  'produit.etat',
  'photos.count',
]) {
  let ok = 0;
  const manquants = [];
  for (const path of trackedFields) {
    const parts = path.split('.');
    let val = normalized;
    for (const p of parts) val = val && val[p];
    if (val != null && val !== '' && val !== 0) ok++;
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
  extractDescription,
  extractPrice,
  extractTransaction,
  extractStats,
  extractPhotos,
  extractSeller,
  extractDates,
  extractCondition,
  scraperQuality,
};
