// 🗺️ ONGLET CARTE — carte interactive Leaflet des annonces localisables.
// Séparé de l'onglet Statistiques : la carte occupe son propre onglet et la
// majeure partie de l'espace disponible.
//
// Contrat de données :
//  - les coordonnées ne sont JAMAIS inventées : une annonce n'est placée que si
//    sa ville/CP est géocodée avec succès ;
//  - le géocodage utilise le service public geo.api.gouv.fr (France) avec un
//    cache localStorage borné ;
//  - aucune image ni donnée n'est écrite sur le disque.

const mapSessionSelect = document.getElementById('mapSessionSelect');
const mapHandDeliveryFilter = document.getElementById('mapHandDeliveryOnly');
const mapRecenterBtn = document.getElementById('mapRecenterBtn');
const mapMinPriceInput = document.getElementById('mapMinPrice');
const mapMaxPriceInput = document.getElementById('mapMaxPrice');

// Compat + sélection des points de carte : regroupés dans un seul IIFE qui
// expose les helpers au `window` pour que les tests puissent les charger
// directement (sans jsdom ni Leaflet). Les fonctions rendues globales portent
// des noms explicites ; le rendu réel (renderMap) reste appelé par loadMapPage.
(() => {
  /**
   * Calcule le deliveryType depuis les anciens champs livraison/mainPropre
   * pour la rétro-compatibilité des annonces cachées sans deliveryType.
   */
  function _computeDeliveryTypeCompatMap(livraison, mainPropre) {
    if (livraison === true && mainPropre === true) return 'les_deux';
    if (livraison === true) return 'livraison';
    if (mainPropre === true) return 'main_propre';
    if (livraison === false && mainPropre === false) return 'aucun';
    if (livraison === false) return 'aucun';
    if (mainPropre === false) return 'aucun';
    return 'inconnu';
  }

  function _deliveryTypeOf(a) {
    return a.deliveryType ?? _computeDeliveryTypeCompatMap(
      a.livraison ?? a.shipping,
      a.mainPropre ?? a.handDelivery
    );
  }

  // Déduplique (une même annonce peut apparaître dans plusieurs sessions) puis
  // applique, si demandé, le filtre « remise en main propre ». Logique pure,
  // testable sans DOM ni Leaflet.
  function computeMapPoints(ads, handDeliveryOnly) {
    const list = Array.isArray(ads) ? ads : [];
    const seen = new Set();
    const deduped = [];
    for (const a of list) {
      const key = a.id || a.url || a.title;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      deduped.push(a);
    }
    const target = handDeliveryOnly
      ? deduped.filter((a) => {
          const dt = _deliveryTypeOf(a);
          return dt === 'main_propre' || dt === 'les_deux';
        })
      : deduped;
    return { deduped, target };
  }

  // Coordonnées valides = [lat, lng] finis, lat ∈ [-90,90], lng ∈ [-180,180].
  // Ignore proprement les coordonnées absentes, nulles ou hors bornes au lieu de
  // placer une annonce à un emplacement inventé.
  function isValidLatLng(coords) {
    return Array.isArray(coords) && coords.length === 2 &&
      Number.isFinite(coords[0]) && Number.isFinite(coords[1]) &&
      coords[0] >= -90 && coords[0] <= 90 &&
      coords[1] >= -180 && coords[1] <= 180;
  }

  /**
   * Regroupe des marqueurs proches dans une grille lat/lng pour éviter de créer
   * des milliers d'éléments DOM (et des marqueurs superposés illisibles).
   * Fonction PURE et testable : aucune dépendance Leaflet/DOM.
   * @param {Array<{lat:number,lng:number,ads:Array}>} points
   * @param {number} cellSize taille de cellule en degrés (0 = pas de regroupement)
   * @returns {Array<{lat:number,lng:number,ads:Array}>} groupes
   */
  function clusterMarkers(points, cellSize) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!(cellSize > 0)) return points.slice();
    const cells = new Map();
    for (const p of points) {
      const key = `${Math.floor(p.lat / cellSize)}:${Math.floor(p.lng / cellSize)}`;
      let cell = cells.get(key);
      if (!cell) { cell = { lat: 0, lng: 0, ads: [] }; cells.set(key, cell); }
      cell.lat += p.lat;
      cell.lng += p.lng;
      cell.ads.push(...(Array.isArray(p.ads) ? p.ads : []));
    }
    const groups = [];
    for (const cell of cells.values()) {
      const n = cell.ads.length || 1;
      groups.push({ lat: cell.lat / n, lng: cell.lng / n, ads: cell.ads });
    }
    return groups;
  }

  Object.assign(window, { _computeDeliveryTypeCompatMap, _deliveryTypeOf, computeMapPoints, isValidLatLng, clusterMarkers });
})();

// 🗺️ Géocodeur officiel API Gouv France avec cache local (localStorage borné).
const GEO_CACHE_MAX = 400;
async function geocodeCityGov(cityName, zipcode) {
  const cleanCity = typeof cityName === 'string' ? cityName.toLowerCase().trim() : '';
  if (!cleanCity && !zipcode) return null;
  const cacheKey = `geo-cache-${cleanCity}-${zipcode || ''}`;

  // Lecture du cache local (tolérant aux données corrompues : un cache mal
  // écrit ne doit pas faire crasher tout le rendu de carte).
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length === 2) return parsed;
      localStorage.removeItem(cacheKey);
    } catch {
      localStorage.removeItem(cacheKey);
    }
  }

  try {
    let url = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(cleanCity)}&fields=centre&limit=1`;
    if (zipcode && /^\d{5}$/.test(zipcode)) {
      url = `https://geo.api.gouv.fr/communes?codePostal=${zipcode}&fields=centre&limit=1`;
    }

    // Timeout : sans AbortController, une API gouv injoignable pouvait bloquer
    // indéfiniment le rendu de la carte (fetch natif n'a pas d'option timeout).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const data = await res.json();
      if (data && data[0] && data[0].centre) {
        const lngLat = data[0].centre.coordinates; // Format gouv : [longitude, latitude]
        const latLng = [lngLat[1], lngLat[0]]; // Format Leaflet : [latitude, longitude]
        trimGeoCache();
        localStorage.setItem(cacheKey, JSON.stringify(latLng));
        return latLng;
      }
    }
  } catch (err) {
    console.warn(`[Geocoding API Gouv] Échec pour la ville ${cityName} :`, err.message);
  }
  return null;
}

// Cache borné : évite une croissance illimitée du localStorage (les clés
// géo-cache les plus anciennes sont purgées au-delà de GEO_CACHE_MAX).
function trimGeoCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('geo-cache-')) keys.push(k);
    }
    if (keys.length >= GEO_CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - GEO_CACHE_MAX + 1)) localStorage.removeItem(k);
    }
  } catch { /* localStorage indisponible : on continue sans purge */ }
}

// Affiche un message d'état sous la carte (aucun point, Leaflet indisponible,
// coordonnées manquantes…) sans toucher au DOM interne de Leaflet (écrire dans
// le conteneur de la carte le détruirait).
function setMapStatus(message) {
  const el = document.getElementById('mapStatus');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

// Seuil au-delà duquel on regroupe les marqueurs (grille adaptative) pour ne
// pas créer des milliers d'éléments DOM simultanés.
const MAP_CLUSTER_THRESHOLD = 250;

// 🗺️ Rendu de la carte interactive.
async function renderMap(ads) {
  // Diagnostic Leaflet : si le script embarqué n'a pas pu charger, on prévient
  // l'utilisateur au lieu de rester silencieux.
  if (typeof L === 'undefined') {
    setMapStatus('Carte indisponible : Leaflet non disponible (la bibliothèque n\'a pas pu être chargée).');
    console.warn('[Carte] Leaflet non disponible (L undefined).');
    return;
  }

  // Invalide tout run précédent : on est désormais la plus récente renderMap.
  const gen = ++mapRenderGen;
  const isStale = () => gen !== mapRenderGen;

  try {
    if (!mapInstance) {
      mapInstance = L.map('leafletMap').setView([46.603354, 1.888334], 5);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap',
      }).addTo(mapInstance);
    }

    // Calque dédié aux marqueurs : vidé à chaque rendu. On n'utilise PAS
    // `instanceof L.Marker` (fragile si le constructeur change de référence) et
    // on garantit l'absence de doublons de marqueurs après plusieurs rendus.
    if (!mapMarkerLayer) {
      mapMarkerLayer = L.layerGroup().addTo(mapInstance);
    }
    mapMarkerLayer.clearLayers();

    const mapHandDeliveryEl = document.getElementById('mapHandDeliveryOnly');
    const mapHandDeliveryOnly = !!(mapHandDeliveryEl && mapHandDeliveryEl.checked);

    // Filtre prix optionnel (ne remplace pas le filtre de l'explorateur).
    const minPriceEl = document.getElementById('mapMinPrice');
    const maxPriceEl = document.getElementById('mapMaxPrice');
    const minPrice = minPriceEl && minPriceEl.value !== '' ? Number(minPriceEl.value) : null;
    const maxPrice = maxPriceEl && maxPriceEl.value !== '' ? Number(maxPriceEl.value) : null;

    const { deduped, target } = computeMapPoints(ads, mapHandDeliveryOnly);
    const priceFiltered = target.filter((a) => {
      const p = typeof a.prix === 'number' ? a.prix : (typeof a.price === 'number' ? a.price : null);
      if (p == null) return minPrice == null && maxPrice == null;
      if (minPrice != null && p < minPrice) return false;
      if (maxPrice != null && p > maxPrice) return false;
      return true;
    });
    const dupes = ads.length - deduped.length;
    console.log(`[Carte] ${mapHandDeliveryOnly ? 'Filtre main propre ON' : 'Filtre main propre OFF'} : ${priceFiltered.length} annonce(s) à géocoder sur ${deduped.length} (${dupes} doublon(s) supprimé(s))`);

    // Rien à afficher : message explicite plutôt qu'une carte muette.
    if (priceFiltered.length === 0) {
      setMapStatus(mapHandDeliveryOnly
        ? 'Aucune annonce en remise en main propre dans cette sélection. Décochez le filtre pour afficher toutes les annonces localisables.'
        : 'Aucune annonce à localiser dans cette sélection.');
      if (mapInstance) mapInstance.invalidateSize();
      return;
    }

    // Géocodage à concurrence limitée (respecte les limites du service public).
    const GEOCODE_CONCURRENCY = 6;
    const queue = [...priceFiltered];
    let placed = 0;
    let geocodeFailed = 0;
    // Regroupe les annonces par coordonnées géocodées : plusieurs annonces d'une
    // même ville ne créent qu'un point, ce qui limite le nombre d'éléments DOM.
    const pointsByCoords = new Map();

    const worker = async () => {
      while (queue.length > 0) {
        if (isStale()) return;
        const a = queue.shift();
        if (!a) break;
        try {
          const coords = await geocodeCityGov(cityOf(a), zipOf(a));
          if (isStale()) return;
          if (!isValidLatLng(coords)) { geocodeFailed++; continue; }
          const key = `${coords[0].toFixed(3)}:${coords[1].toFixed(3)}`;
          let group = pointsByCoords.get(key);
          if (!group) { group = { lat: coords[0], lng: coords[1], ads: [] }; pointsByCoords.set(key, group); }
          group.ads.push(a);
        } catch (err) {
          geocodeFailed++;
          console.warn(`[Carte] géocodage échoué pour ${cityOf(a) || '?'} :`, err.message);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(GEOCODE_CONCURRENCY, priceFiltered.length) }, () => worker()));

    // Un rendu plus récent a pris le relais : ne pas écraser son message.
    if (isStale()) return;

    const allPoints = Array.from(pointsByCoords.values());
    const cellSize = allPoints.length > MAP_CLUSTER_THRESHOLD ? 0.25 : 0;
    const groups = clusterMarkers(allPoints, cellSize);

    for (const g of groups) {
      const first = g.ads[0];
      // Léger décalage pour éviter la superposition exacte de plusieurs points
      // d'une même ville ; reste dans l'ordre [latitude, longitude] attendu par
      // Leaflet (le géocodeur gouv renvoie [longitude, latitude], déjà inversé).
      const jitterCoords = [
        g.lat + (Math.random() - 0.5) * 0.012,
        g.lng + (Math.random() - 0.5) * 0.012,
      ];
      const marker = L.marker(jitterCoords);
      const dt = _deliveryTypeOf(first);
      const deliveryTxt = dt === 'livraison' ? 'Livraison possible'
        : dt === 'main_propre' ? 'Remise en main propre'
        : dt === 'les_deux' ? 'Livraison + Main propre'
        : dt === 'aucun' ? 'Aucune remise'
        : 'Remise non précisée';
      // Le popup indique que la localisation correspond à la VILLE, pas à
      // l'adresse exacte (aucune donnée d'adresse n'est collectée).
      const countTxt = g.ads.length > 1 ? `<em>${g.ads.length} annonces dans cette commune</em><br>` : '';
      marker.bindPopup(`
        <div style="font-family:sans-serif; font-size:0.8rem; line-height:1.3;">
          ${countTxt}
          <strong>${escapeHtml(first.title || 'Sans titre')}</strong><br>
          <span style="color:var(--primary-color); font-weight:bold;">${first.prix != null ? first.prix + ' €' : (first.price != null ? first.price + ' €' : '-')}</span><br>
          ${escapeHtml(locationLabel(first))} <span style="color:#94a3b8;">(ville)</span><br>
          ${deliveryTxt}<br>
          <a href="#" data-action="openUrl" data-url="${escapeHtml(first.url)}" style="color:#38bdf8; text-decoration:underline;">Ouvrir l'annonce</a>
          ${first.id ? ` · <a href="#" data-action="openAdDetail" data-id="${escapeHtml(String(first.id))}" style="color:#38bdf8; text-decoration:underline;">Fiche</a>` : ''}
        </div>
      `);
      mapMarkerLayer.addLayer(marker);
      placed++;
    }

    // Compte-rendu utilisateur : nombre de points affichés + raison si vide.
    if (placed === 0) {
      setMapStatus('Aucune annonce localisable dans cette sélection (villes ou codes postaux absents ou non reconnus par le géocodage).');
    } else {
      const parts = [`${placed} point(s) affiché(s) pour ${priceFiltered.length} annonce(s).`];
      if (geocodeFailed > 0) parts.push(`${geocodeFailed} sans coordonnées exploitables.`);
      if (dupes > 0) parts.push(`${dupes} doublon(s) ignoré(s).`);
      setMapStatus(parts.join(' '));
    }

    // Important : invalider la taille après le rendu pour que Leaflet recalcule
    if (mapInstance) mapInstance.invalidateSize();
  } catch (err) {
    console.error('[Carte] Erreur lors du rendu de la carte :', err.message);
    setMapStatus('Impossible d\'afficher la carte (erreur d\'initialisation).');
  }
}

// Recentre la carte sur les marqueurs affichés.
function recenterMap() {
  if (!mapInstance || !mapMarkerLayer) return;
  try {
    const layers = mapMarkerLayer.getLayers();
    if (!layers.length) return;
    const bounds = L.latLngBounds(layers.map((m) => m.getLatLng()));
    mapInstance.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  } catch (err) {
    console.warn('[Carte] recentrage impossible :', err.message);
  }
}

// 🗺️ Chargement de l'onglet Carte : sessions puis rendu de la carte.
async function loadMapPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(mapSessionSelect);
  renderMapView();
}

function renderMapView() {
  const selectedJobId = mapSessionSelect ? mapSessionSelect.value : 'ALL';
  let sourceAds = [];
  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => { if (Array.isArray(j.ads)) sourceAds.push(...j.ads); });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }
  renderMap(sourceAds);
}

if (mapSessionSelect) mapSessionSelect.addEventListener('change', renderMapView);
if (mapHandDeliveryFilter) mapHandDeliveryFilter.addEventListener('change', renderMapView);
if (mapRecenterBtn) mapRecenterBtn.addEventListener('click', recenterMap);
if (mapMinPriceInput) mapMinPriceInput.addEventListener('change', renderMapView);
if (mapMaxPriceInput) mapMaxPriceInput.addEventListener('change', renderMapView);
