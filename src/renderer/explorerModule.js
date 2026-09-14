const adsTableContainer = document.getElementById('adsTableContainer');
const adsTableBody = document.getElementById('adsTableBody');
const adsGridContainer = document.getElementById('adsGridContainer');
const filteredAdsCount = document.getElementById('filteredAdsCount');

const viewTableBtn = document.getElementById('viewTableBtn');
const viewGridBtn = document.getElementById('viewGridBtn');

const filterKeyword = document.getElementById('filterKeyword');
const filterPriceMin = document.getElementById('filterPriceMin');
const filterPriceMax = document.getElementById('filterPriceMax');
const filterTagSelect = document.getElementById('filterTagSelect');
const sortSelect = document.getElementById('sortSelect');
const filterLivraison = document.getElementById('filterLivraison');
const filterMainPropre = document.getElementById('filterMainPropre');
const filterSellerType = document.getElementById('filterSellerType');
const filterMinRating = document.getElementById('filterMinRating');
const filterMinLikes = document.getElementById('filterMinLikes');
const filterEtat = document.getElementById('filterEtat');
const triggerMarketBtn = document.getElementById('triggerMarketBtn');

const structureWarningCloseBtn = document.getElementById('structureWarningClose');
if (structureWarningCloseBtn) {
  structureWarningCloseBtn.addEventListener('click', () => {
    document.getElementById('structureWarning')?.classList.add('hidden');
  });
}

// Modal Suppression & Detail
const closeDetailModalBtn = document.getElementById('closeDetailModalBtn');
const modalAdTitle = document.getElementById('modalAdTitle');
const mainGalleryImg = document.getElementById('mainGalleryImg');
const galleryThumbnails = document.getElementById('galleryThumbnails');
const modalDealBadge = document.getElementById('modalDealBadge');
const modalStarBtn = document.getElementById('modalStarBtn');
const modalPrice = document.getElementById('modalPrice');
const modalMarketRange = document.getElementById('modalMarketRange');
const modalMarketAvg = document.getElementById('modalMarketAvg');
const modalResellMargin = document.getElementById('modalResellMargin');
const modalCity = document.getElementById('modalCity');
const modalSeller = document.getElementById('modalSeller');
const modalDate = document.getElementById('modalDate');
const modalSummary = document.getElementById('modalSummary');
const modalVisionCard = document.getElementById('modalVisionCard');
const modalVisionContent = document.getElementById('modalVisionContent');
const modalDescription = document.getElementById('modalDescription');
const modalOpenLeboncoinBtn = document.getElementById('modalOpenLeboncoinBtn');

// ─── Helpers de rendu IA (nouveau système : Analyse + Marché) ───────────────
// Centralisent l'affichage des résultats des IA 1 (adAnalysis) et 2 (marketAnalysis)
// pour éviter la duplication entre tableau, grille, comparateur et fiche détaillée.

/**
 * Renvoie un badge HTML pour le verdict de l'IA Marché (bénéfice/perte en €).
 * Plus de score/100 ni de scam score : uniquement la différence de prix.
 */
function renderMarketBadge(ma) {
  if (!ma || ma._fallback || ma.verdict == null) {
    return `<span class="tag-deal-normal">Marché non analysé</span>`;
  }
  const label = ma.verdictLabel || 'Prix correct';
  const delta = ma.deltaEur;
  const sign = delta > 0 ? '+' : '';
  if (label === 'Très bonne affaire') return `<span class="tag-deal-super">🟢🟢 Très bonne affaire (${sign}${delta} €)</span>`;
  if (label === 'Bonne affaire') return `<span class="tag-deal-good">🟢 Bonne affaire (${sign}${delta} €)</span>`;
  if (label === 'Très cher') return `<span class="tag-deal-superhigh">🔴🔴 Très cher (${sign}${delta} €)</span>`;
  if (label === 'Trop cher') return `<span class="tag-deal-superhigh">🔴 Trop cher (${sign}${delta} €)</span>`;
  return `<span class="tag-deal-normal">${label} (${sign}${delta} €)</span>`;
}

/** Nom identifié par l'IA Analyse (fallback sur le titre si absent). */
function identifiedName(a) {
  const aa = a.adAnalysis;
  if (aa && aa.identifiedProduct && !aa._fallback) return aa.identifiedProduct;
  return a.title || 'Sans titre';
}

/** Résumé court produit par l'IA Analyse (fallback sur la description). */
function analysisSummary(a) {
  const aa = a.adAnalysis;
  if (aa && aa.summary && !aa._fallback) return aa.summary;
  return (a.description || '').slice(0, 120) || 'Aucun résumé IA disponible.';
}

/** Bénéfice/perte lisible (€) issu de l'IA Marché. */
function marketDeltaText(ma) {
  if (!ma || ma._fallback || ma.deltaEur == null) return '-';
  const sign = ma.deltaEur > 0 ? '+' : '';
  const color = ma.deltaEur >= 0 ? 'var(--green-deal)' : 'var(--text-muted)';
  return `<strong style="color:${color};">${sign}${ma.deltaEur} €</strong>`;
}

/** Valeur réelle estimée (€) issue de l'IA Marché. */
function marketValueText(ma) {
  if (!ma || ma._fallback || ma.realValue == null) return '<small style="color:var(--text-muted);">Non estimé</small>';
  let txt = `<strong>${ma.realValue} €</strong>`;
  if (ma.valueRangeLow != null && ma.valueRangeHigh != null) {
    txt += `<br><small style="color:var(--text-muted);">${ma.valueRangeLow} € - ${ma.valueRangeHigh} €</small>`;
  }
  return txt;
}

/** Filtre les annonces par verdict (pour le filtre tag de l'Explorateur). */
function matchesVerdictFilter(a, tagFilter) {
  if (tagFilter === 'FAV') return starredAds.has(String(a.id));
  const v = a.marketAnalysis && a.marketAnalysis.verdictLabel;
  if (tagFilter === 'SUPER') return v === 'Très bonne affaire';
  if (tagFilter === 'GOOD') return v === 'Bonne affaire' || v === 'Très bonne affaire';
  if (tagFilter === 'HIGH') return v === 'Trop cher' || v === 'Très cher';
  return true;
}

// BASCULE DE VUE TABLEAU / GALERIE
viewTableBtn.addEventListener('click', () => {
  viewMode = 'table';
  localStorage.setItem('explorer-view', 'table');
  viewTableBtn.classList.add('active');
  viewGridBtn.classList.remove('active');
  adsTableContainer.classList.remove('hidden');
  adsGridContainer.classList.add('hidden');
  renderExplorerAds();
});

viewGridBtn.addEventListener('click', () => {
  viewMode = 'grid';
  localStorage.setItem('explorer-view', 'grid');
  viewGridBtn.classList.add('active');
  viewTableBtn.classList.remove('active');
  adsTableContainer.classList.add('hidden');
  adsGridContainer.classList.remove('hidden');
  renderExplorerAds();
});

if (viewMode === 'grid') viewGridBtn.click();

// PAGE 4 : EXPLORATEUR D'ANNONCES
async function loadExplorerPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(sessionSelect);
  populateEtatFilter();
  restoreExplorerFilters();
  renderExplorerAds();
}

function populateSessionDropdown(selectEl) {
  const selectedVal = selectEl.value;
  selectEl.innerHTML = '<option value="ALL">🌐 Tous les scrapings combinés (Recherche globale)</option>';

  allJobsCache.forEach((j) => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `📅 Session du ${j.date} (${j.adsCount} annonces)`;
    selectEl.appendChild(opt);
  });

  if (selectedVal) selectEl.value = selectedVal;
}

// Écouteurs de filtrage sécurisés (Évitent tout plantage en cas d'élément absent)
if (filterKeyword) filterKeyword.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMin) filterPriceMin.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterPriceMax) filterPriceMax.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterTagSelect) filterTagSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (sortSelect) sortSelect.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
// Filtres scraping (livraison / main propre / type vendeur / note min / likes min / état)
if (filterLivraison) filterLivraison.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterMainPropre) filterMainPropre.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterSellerType) filterSellerType.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterMinRating) filterMinRating.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterMinLikes) filterMinLikes.addEventListener('input', () => { saveExplorerFilters(); renderExplorerAds(); });
if (filterEtat) filterEtat.addEventListener('change', () => { saveExplorerFilters(); renderExplorerAds(); });

// Changement de session : rafraîchit immédiatement tout l'explorateur (sans
// avoir à manipuler un autre filtre pour déclencher la mise à jour).
if (sessionSelect) sessionSelect.addEventListener('change', () => { renderExplorerAds(); });

// Sauvegarde / restauration des filtres entre les sessions
function saveExplorerFilters() {
  try {
    localStorage.setItem('explorer-filters', JSON.stringify({
      keyword: filterKeyword?.value || '',
      priceMin: filterPriceMin?.value || '',
      priceMax: filterPriceMax?.value || '',
      tag: filterTagSelect?.value || 'ALL',
      sort: sortSelect?.value || 'DEFAULT',
      livraison: filterLivraison?.value || 'ALL',
      mainPropre: filterMainPropre?.value || 'ALL',
      sellerType: filterSellerType?.value || 'ALL',
      minRating: filterMinRating?.value || '',
      minLikes: filterMinLikes?.value || '',
      etat: filterEtat?.value || 'ALL',
    }));
  } catch { /* quota dépassé */ }
}

function restoreExplorerFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem('explorer-filters') || '{}');
    if (saved.keyword && filterKeyword) filterKeyword.value = saved.keyword;
    if (saved.priceMin != null && filterPriceMin) filterPriceMin.value = saved.priceMin;
    if (saved.priceMax != null && filterPriceMax) filterPriceMax.value = saved.priceMax;
    if (saved.tag && filterTagSelect) filterTagSelect.value = saved.tag;
    if (saved.sort && sortSelect) sortSelect.value = saved.sort;
    if (saved.livraison && filterLivraison) filterLivraison.value = saved.livraison;
    if (saved.mainPropre && filterMainPropre) filterMainPropre.value = saved.mainPropre;
    if (saved.sellerType && filterSellerType) filterSellerType.value = saved.sellerType;
    if (saved.minRating != null && filterMinRating) filterMinRating.value = saved.minRating;
    if (saved.minLikes != null && filterMinLikes) filterMinLikes.value = saved.minLikes;
    if (saved.etat && filterEtat) filterEtat.value = saved.etat;
  } catch { /* JSON corrompu */ }
}

/**
 * Peuple le sélecteur d'état avec les valeurs distinctes trouvées dans les
 * annonces (État déclaré par le vendeur : "Neuf", "Très bon état", etc.).
 */
function populateEtatFilter() {
  if (!filterEtat) return;
  const etats = new Set();
  for (const j of allJobsCache) {
    if (!Array.isArray(j.ads)) continue;
    for (const a of j.ads) {
      const e = a.produit?.etat;
      if (e) etats.add(e);
    }
  }
  const current = filterEtat.value;
  const opts = ['<option value="ALL">Tous états</option>',
    ...[...etats].sort().map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`)];
  filterEtat.innerHTML = opts.join('');
  if (current && etats.has(current)) filterEtat.value = current;
  else filterEtat.value = 'ALL';
}

function renderExplorerAds() {
  const selectedJobId = sessionSelect.value;
  const query = filterKeyword.value.toLowerCase().trim();
  const tagFilter = filterTagSelect.value;
  const sortMode = sortSelect.value;

  const minP = parseFloat(filterPriceMin.value) || 0;
  const maxP = parseFloat(filterPriceMax.value) || Infinity;
  // Filtres scraping
  const livraisonFilter = filterLivraison ? filterLivraison.value : 'ALL';
  const mainPropreFilter = filterMainPropre ? filterMainPropre.value : 'ALL';
  const sellerTypeFilter = filterSellerType ? filterSellerType.value : 'ALL';
  const minRating = filterMinRating && filterMinRating.value !== '' ? parseFloat(filterMinRating.value) : null;
  const minLikes = filterMinLikes && filterMinLikes.value !== '' ? parseInt(filterMinLikes.value, 10) : null;
  const etatFilter = filterEtat ? filterEtat.value : 'ALL';

  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  // Helpers lecture champs structurés / legacy
  const livraisonOf = (a) => a.livraison ?? a.shipping;
  const mainPropreOf = (a) => a.mainPropre ?? a.handDelivery;
  const typeVendeurOf = (a) => a.vendeurType || 'particulier';
  const noteOf = (a) => a.vendeurNote != null ? a.vendeurNote : a.sellerRating;
  const likesOf = (a) => a.likes != null ? a.likes : (a.favorites_count != null ? a.favorites_count : null);
  const datePubOf = (a) => a.datePublication || a.date;
  const dateScrapeOf = (a) => a.dateScraping;
  const etatOf = (a) => a.etat;

  // Helper description (lit description si string, ou description.originale si objet legacy)
  const descTextOf = (a) => {
    if (!a) return '';
    if (typeof a.description === 'string') return a.description;
    if (typeof a.description === 'object' && typeof a.description.originale === 'string') return a.description.originale;
    return '';
  };

  let filtered = sourceAds.filter((a) => {
    const desc = descTextOf(a);
    const fullText = `${a.title || ''} ${desc} ${a.city || ''} ${a.vendeurNom || a.seller || ''}`.toLowerCase();
    const matchesQuery = !query || fullText.includes(query);

    const price = typeof a.prix === 'number' ? a.prix : (typeof a.price === 'number' ? a.price : parseFloat(a.price) || 0);
    const matchesPrice = price >= minP && price <= maxP;

    const matchesTag = matchesVerdictFilter(a, tagFilter);

    // Livraison : OUI / NON
    let matchesLivraison = true;
    if (livraisonFilter === 'OUI') matchesLivraison = livraisonOf(a) === true;
    else if (livraisonFilter === 'NON') matchesLivraison = livraisonOf(a) === false;

    // Main propre : OUI / NON
    let matchesMainPropre = true;
    if (mainPropreFilter === 'OUI') matchesMainPropre = mainPropreOf(a) === true;
    else if (mainPropreFilter === 'NON') matchesMainPropre = mainPropreOf(a) === false;

    // Type vendeur
    const matchesSellerType = !includeSellerData || sellerTypeFilter === 'ALL' ||
      (sellerTypeFilter === 'PRO' && typeVendeurOf(a) === 'pro') ||
      (sellerTypeFilter === 'PART' && typeVendeurOf(a) === 'particulier');

    // Note min
    let matchesRating = !includeSellerData || true;
    if (includeSellerData && minRating != null) {
      const r = noteOf(a);
      matchesRating = r != null && r >= minRating;
    }

    // Likes min
    let matchesLikes = true;
    if (minLikes != null) {
      const l = likesOf(a);
      matchesLikes = l != null && l >= minLikes;
    }

    // État déclaré
    const matchesEtat = etatFilter === 'ALL' || (etatOf(a) && etatOf(a) === etatFilter);

    return matchesQuery && matchesPrice && matchesTag && matchesLivraison && matchesMainPropre
      && matchesSellerType && matchesRating && matchesLikes && matchesEtat;
  });

  if (sortMode === 'DEAL_DESC') {
    filtered.sort((a, b) => (b.marketAnalysis?.deltaEur ?? -Infinity) - (a.marketAnalysis?.deltaEur ?? -Infinity));
  } else if (sortMode === 'PRICE_ASC') {
    filtered.sort((a, b) => ((a.prix ?? a.price) || 0) - ((b.prix ?? b.price) || 0));
  } else if (sortMode === 'PRICE_DESC') {
    filtered.sort((a, b) => ((b.prix ?? b.price) || 0) - ((a.prix ?? a.price) || 0));
  } else if (sortMode === 'RATING_DESC') {
    filtered.sort((a, b) => (noteOf(b) ?? -1) - (noteOf(a) ?? -1));
  } else if (sortMode === 'LIKES_DESC') {
    filtered.sort((a, b) => (likesOf(b) ?? -1) - (likesOf(a) ?? -1));
  } else if (sortMode === 'DATE_PUB_DESC') {
    filtered.sort((a, b) => new Date(datePubOf(b) || 0).getTime() - new Date(datePubOf(a) || 0).getTime());
  } else if (sortMode === 'DATE_SCRAPE_DESC') {
    filtered.sort((a, b) => new Date(dateScrapeOf(b) || 0).getTime() - new Date(dateScrapeOf(a) || 0).getTime());
  }

  filteredAdsCount.textContent = filtered.length;

  if (filtered.length === 0) {
    adsTableBody.innerHTML = '<tr><td colspan="11" class="text-center">Aucune annonce ne correspond à votre recherche</td></tr>';
    adsGridContainer.innerHTML = '<div class="text-center" style="grid-column:1/-1;">Aucune annonce ne correspond à votre recherche</div>';
    return;
  }

  if (viewMode === 'table') {
    adsTableBody.innerHTML = filtered
      .map((a) => {
        const ma = a.marketAnalysis || {};
        const badgeHtml = renderMarketBadge(ma);

        const isStarred = starredAds.has(String(a.id));
        const starIcon = `<span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${escapePath(a.id)}')">★</span>`;
        const isChecked = compareSet.has(String(a.id));

        const nameHtml = (a.adAnalysis && !a.adAnalysis._fallback && a.adAnalysis.identifiedProduct)
          ? `<strong>${escapeHtml(a.adAnalysis.identifiedProduct)}</strong><br><small style="color:var(--text-muted);">${escapeHtml(a.title)}</small>`
          : escapeHtml(a.title || 'Sans titre');

        // Pastilles livraison / main propre / likes / note vendeur (visuelles)
        const livraison = livraisonOf(a);
        const mainPropre = mainPropreOf(a);
        const livraisonChip = livraison === true ? ' <span title="Livraison" style="color:#38bdf8;">📦</span>'
          : livraison === false ? '' : ' <span title="Livraison indéterminée" style="color:var(--text-muted);">📦?</span>';
        const mainPropreChip = mainPropre === true ? ' <span title="Main propre" style="color:#22c55e;">🤝</span>'
          : mainPropre === false ? '' : '';
        const note = noteOf(a);
        const noteChip = includeSellerData && note != null ? ` <span title="Note vendeur" style="color:#facc15;">⭐${String(note).replace('.', ',')}</span>` : '';
        const likesVal = likesOf(a);
        const likesChip = includeSellerData && likesVal != null ? ` <span title="Likes" style="color:#ef4444;">❤️${likesVal}</span>` : '';

        const valueHtml = marketValueText(ma);
        const deltaHtml = marketDeltaText(ma);
        const summaryHtml = `<div class="desc-tooltip" title="${escapeHtml(analysisSummary(a))}">${escapeHtml(analysisSummary(a))}</div>`;
        const sellerChip = includeSellerData ? `<small style="color:var(--text-muted);">${escapeHtml(a.vendeurNom || 'Particulier')}</small>` : '';
        const typeVendeurBadge = includeSellerData ? ((a.vendeurType === 'pro') ? '<span style="background:var(--accent); color:white; padding:1px 5px; border-radius:3px; font-size:0.7rem;">PRO</span>' : '<span style="background:var(--bg-secondary); padding:1px 5px; border-radius:3px; font-size:0.7rem;">PART</span>') : '';

        const priceText = a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-');
        return `
        <tr>
          <td class="text-center"><input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleCompare('${escapePath(a.id)}')"></td>
          <td class="text-center">${starIcon}</td>
          <td>${nameHtml}</td>
          <td><strong>${escapeHtml(String(priceText))}</strong></td>
          <td>${valueHtml}</td>
          <td>${deltaHtml}</td>
          <td>${badgeHtml}</td>
          <td>${sellerChip} ${typeVendeurBadge}${noteChip}${likesChip}</td>
          <td>${livraisonChip}${mainPropreChip}</td>
          <td>${summaryHtml}</td>
          <td>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-secondary btn-small" onclick="openAdDetail('${escapePath(a.id)}')">👁️ Fiche</button>
              <button class="btn btn-secondary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  if (viewMode === 'grid') {
    adsGridContainer.innerHTML = filtered
      .map((a) => {
        const ma = a.marketAnalysis || {};
        const badgeHtml = renderMarketBadge(ma);

        const isStarred = starredAds.has(String(a.id));
        const thumbUrl = (Array.isArray(a.photosUrls) && a.photosUrls.length > 0) ? a.photosUrls[0]
          : (Array.isArray(a.images) && a.images.length > 0 ? a.images[0] : noPhotoUrl());

        return `
        <div class="ad-card">
          <div class="ad-card-thumb-box">
            <img src="${escapeHtml(thumbUrl)}" alt="Photo" class="ad-card-thumb" onclick="openAdDetail('${escapePath(a.id)}')">
            <div class="ad-card-badge-box">${badgeHtml}</div>
            <div class="ad-card-star"><span class="star-icon ${isStarred ? 'starred' : ''}" onclick="toggleStar('${escapePath(a.id)}')">★</span></div>
          </div>
          <div class="ad-card-body">
            <div class="ad-card-title">${escapeHtml(identifiedName(a))}</div>
            <div class="ad-card-price">${escapeHtml(String(a.prix != null ? a.prix + ' €' : (a.price != null ? a.price + ' €' : '-')))}</div>
            <div class="ad-card-city">📍 ${escapeHtml(a.city || 'Inconnue')}</div>
            <div class="ad-card-footer">
              <button class="btn btn-secondary btn-small" style="flex:1;" onclick="openAdDetail('${escapePath(a.id)}')">👁️ Fiche Détaillée</button>
              <button class="btn btn-primary btn-small" onclick="openUrl('${escapePath(a.url)}')">🔗 Voir</button>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }
}

// ⭐ SYSTÈME DE FAVORIS
window.toggleStar = (adId) => {
  const idStr = String(adId);
  if (starredAds.has(idStr)) starredAds.delete(idStr);
  else starredAds.add(idStr);

  localStorage.setItem('starred-ads', JSON.stringify([...starredAds]));
  renderExplorerAds();
};

// 👁️ MODAL FICHE DÉTAILLÉE DE L'ANNONCE
window.openAdDetail = (adId) => {
  let targetAd = null;
  allJobsCache.forEach((j) => {
    if (Array.isArray(j.ads)) {
      const found = j.ads.find((a) => String(a.id) === String(adId));
      if (found) targetAd = found;
    }
  });

  if (!targetAd) return;

  /**
   * Formate une date ISO en JJ/MM/AAAA HH:MM:SS (FR).
   * Renvoie la chaîne d'entrée si la date est invalide/absente.
   */
  function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  const ma = targetAd.marketAnalysis || {};
  const aa = targetAd.adAnalysis || {};
  modalAdTitle.textContent = identifiedName(targetAd);
  modalPrice.textContent = targetAd.prix != null ? targetAd.prix : (targetAd.price != null ? targetAd.price : '-');
  modalMarketAvg.textContent = ma.realValue != null ? `${ma.realValue} €` : '-';
  modalMarketRange.textContent = (ma.valueRangeLow != null && ma.valueRangeHigh != null)
    ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €`
    : 'Non estimé';
  modalResellMargin.textContent = ma.deltaEur != null
    ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} € (${ma.verdictLabel || '—'})`
    : '-';
  modalCity.textContent = targetAd.city || 'Inconnue';
  modalSeller.textContent = includeSellerData ? `${targetAd.vendeurNom || targetAd.seller || 'Particulier'}${targetAd.isPro ? ' (Pro)' : ''}` : ' Masqué';
  modalDate.textContent = targetAd.datePublication || targetAd.date || '-';

  // Nouveaux champs : catégorie, note vendeur, mode de remise
  const setExtraVal = (spanId, text) => {
    const span = document.getElementById(spanId);
    if (span) {
      const valEl = span.querySelector('.modal-extra-val');
      if (valEl) valEl.textContent = text;
    }
  };


  let ratingText = '-';
  const note = targetAd.vendeurNote != null ? targetAd.vendeurNote : targetAd.sellerRating;
  const nbAvis = targetAd.nombreAvis != null ? targetAd.nombreAvis : null;
  if (includeSellerData && note != null) {
    ratingText = `${note}/5`;
    if (nbAvis != null) ratingText += ` (${nbAvis} avis)`;
  }
  setExtraVal('modalSellerRating', includeSellerData ? (note != null ? ratingText : '❓ Aucune note') : ' Masqué');

  // Livraison et Main propre INDÉPENDANTS
  const livraison = targetAd.livraison != null ? targetAd.livraison : targetAd.shipping;
  const mainPropre = targetAd.mainPropre != null ? targetAd.mainPropre : targetAd.handDelivery;

  const livraisonLabels = { true: '📦 OUI', false: 'NON', null: '❓ Indéterminé' };
  const mainPropreLabels = { true: '🤝 OUI', false: 'NON', null: '❓ Indéterminé' };
  setExtraVal('modalLivraison', livraisonLabels[livraison]);
  setExtraVal('modalMainPropre', mainPropreLabels[mainPropre]);

  // Likes
  const likes = targetAd.likes != null ? targetAd.likes : null;
  setExtraVal('modalLikes', likes != null ? `❤️ ${likes}` : '❓ Indisponible');

  // Date scraping
  const dateScrape = targetAd.dateScraping;
  setExtraVal('modalDateScraping', dateScrape ? `🕒 ${formatDateTime(dateScrape)}` : '❓ Indisponible');

  // Type vendeur
  const typeVendeur = targetAd.vendeurType || (targetAd.isPro ? 'pro' : 'particulier');
  const typeVendeurLabel = includeSellerData ? (typeVendeur === 'pro' ? '🏪 Professionnel' : '👤 Particulier') : ' Masqué';
  setExtraVal('modalTypeVendeur', typeVendeurLabel);

  // État déclaré uniquement
  const etat = targetAd.etat;
  setExtraVal('modalEtat', etat || '❓ Non précisé');
  // Résumé IA : combine le résumé de l'IA Analyse (ce qu'est l'objet) et la
  // rationale de l'IA Marché (pourquoi cette estimation en €).
  let summaryText = aa.summary || '';
  if (ma.rationale && !ma._fallback) {
    summaryText = summaryText ? `${summaryText}\n\n💰 ${ma.rationale}` : `💰 ${ma.rationale}`;
  }
  if (Array.isArray(ma.sources) && ma.sources.length > 0) {
    const srcTxt = ma.sources.slice(0, 3).map((s) => s.title || s.url || s).join(' · ');
    summaryText = summaryText ? `${summaryText}\n\nSources marché : ${srcTxt}` : `Sources marché : ${srcTxt}`;
  }
  modalSummary.textContent = summaryText || 'Aucune analyse IA disponible. Lancez « Analyse IA » puis « IA Marché ».';
  // Description : lire description string directement (structure plate v3)
  const modalDescText = typeof targetAd.description === 'string' ? targetAd.description
    : (typeof targetAd.description === 'object' && typeof targetAd.description.originale === 'string' ? targetAd.description.originale : '');
  modalDescription.textContent = modalDescText || 'Aucune description disponible.';

  // Analyse visuelle IA : désormais intégrée dans adAnalysis.vision (produite
  // par l'IA Analyse en un seul appel texte+vision). Fallback imageAnalysis
  // pour les jeux de données analysés avec l'ancien système.
  const vision = (targetAd.adAnalysis && targetAd.adAnalysis.vision) || targetAd.imageAnalysis || null;
  if (vision && (vision.photoType || vision.visibleCondition || vision.summary)) {
    const photoTypeLabels = {
      REAL_PRODUCT: '📸 Photo authentique (produit réel)',
      STOCK_PHOTO: '🏢 Photo constructeur/marketing',
      SCREENSHOT: '🖥️ Capture d\'écran',
      UNCLEAR: '❓ Type indéterminé',
    };
    const conditionLabels = {
      NEW: '🆕 Neuf',
      LIKE_NEW: '✨ Comme neuf',
      GOOD: '👍 Bon état',
      WORN: '⚠️ Usé',
      DAMAGED: '🔴 Endommagé',
    };
    const photoType = photoTypeLabels[vision.photoType] || vision.photoType || '-';
    const condition = conditionLabels[vision.visibleCondition] || vision.visibleCondition || '-';
    const defects = Array.isArray(vision.visibleDefects) && vision.visibleDefects.length > 0
      ? vision.visibleDefects.join(', ')
      : 'Aucun défaut visible';
    const authScore = vision.authenticityScore != null ? `${vision.authenticityScore}/100` : '-';
    const authColor = vision.authenticityScore >= 70 ? '#4caf50' : (vision.authenticityScore >= 40 ? '#ff9800' : '#f44336');

    // Les champs vision proviennent du LLM : ils ne sont PAS fiables.
    // Échapper systématiquement avant injection HTML pour prévenir le XSS.
    const safe = (v) => escapeHtml(v == null ? '' : String(v));
    modalVisionContent.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
        <div><strong>Type photo :</strong><br>${safe(photoType)}</div>
        <div><strong>État visible :</strong><br>${safe(condition)}</div>
        <div><strong>Défauts :</strong><br>${safe(defects)}</div>
        <div><strong>Authenticité :</strong><br><span style="color:${authColor}; font-weight:bold;">${safe(authScore)}</span></div>
      </div>
      <div style="padding:8px; background:var(--bg-secondary); border-radius:6px; margin-top:6px;">
        💬 ${safe(vision.summary || vision.visionSummary || 'Aucun résumé visuel disponible.')}
      </div>
    `;
    modalVisionCard.classList.remove('hidden');
  } else {
    modalVisionCard.classList.add('hidden');
  }

  // Badge verdict IA Marché (bénéfice/perte en € — plus de score ni de %)
  if (ma && !ma._fallback && ma.verdictLabel) {
    const cls = ma.verdictLabel === 'Très bonne affaire' ? 'tag-deal-super'
      : ma.verdictLabel === 'Bonne affaire' ? 'tag-deal-good'
      : (ma.verdictLabel === 'Trop cher' || ma.verdictLabel === 'Très cher') ? 'tag-deal-superhigh'
      : 'tag-deal-normal';
    modalDealBadge.className = cls;
    const sign = ma.deltaEur > 0 ? '+' : '';
    modalDealBadge.textContent = `${ma.verdictLabel} (${sign}${ma.deltaEur != null ? ma.deltaEur : '?'} €)`;
  } else {
    modalDealBadge.className = 'tag-deal-normal';
    modalDealBadge.textContent = 'Marché non analysé';
  }

  // Photos & Carrousel
  const images = (Array.isArray(targetAd.photosUrls) && targetAd.photosUrls.length > 0) ? targetAd.photosUrls
    : (Array.isArray(targetAd.images) && targetAd.images.length > 0 ? targetAd.images : [noPhotoUrl()]);
  mainGalleryImg.src = images[0];

  galleryThumbnails.innerHTML = images
    .map(
      (img, i) => `<img src="${escapeHtml(img)}" alt="Thumb" class="thumb-img ${i === 0 ? 'active' : ''}" onclick="switchGalleryImg('${escapePath(img)}', this)">`
    )
    .join('');

  window.switchGalleryImg = (url, el) => {
    mainGalleryImg.src = url;
    document.querySelectorAll('.thumb-img').forEach((t) => t.classList.remove('active'));
    el.classList.add('active');
  };

  modalOpenLeboncoinBtn.onclick = () => window.openUrl(targetAd.url);

  const isStarred = starredAds.has(String(targetAd.id));
  modalStarBtn.textContent = isStarred ? '⭐ Enlevé des Favoris' : '☆ Ajouter aux Favoris';
  modalStarBtn.onclick = () => {
    window.toggleStar(targetAd.id);
    window.openAdDetail(targetAd.id);
  };

  adDetailModal.classList.remove('hidden');
};

closeDetailModalBtn.addEventListener('click', () => {
  adDetailModal.classList.add('hidden');
});
