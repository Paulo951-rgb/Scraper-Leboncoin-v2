/**
 * priceEvolutionModule — onglet « Évolution des prix ».
 *
 * Responsabilités (couche E) :
 *   - rechercher/afficher les produits identifiés (liste paginée) ;
 *   - afficher la fiche détaillée d'un produit (stats, série, segments, alias,
 *     annonces incluses/exclues) ;
 *   - afficher la file des rapprochements incertains et permettre de CORRIGER
 *     une association (persistée côté main, recalcul des stats).
 *
 * PRINCIPES :
 *   - AUCUNE donnée n'est calculée ici : les statistiques viennent du main
 *     (couche D, déterministe). Le renderer ne fait que formater/afficher.
 *   - AUCUNE donnée fictive : si une valeur est absente, on affiche « — ».
 *   - Tout texte issu de la base est échappé (escapeHtml) : les descriptions
 *     d'annonces sont des DONNÉES, jamais du HTML.
 *   - La liste est paginée : on ne charge JAMAIS toute la base d'un coup.
 */

'use strict';

// ─── Éléments DOM ────────────────────────────────────────────────────────────
const peEmptyState = document.getElementById('peEmptyState');
const peFilters = document.getElementById('peFilters');
const peSearch = document.getElementById('peSearch');
const peFamilyFilter = document.getElementById('peFamilyFilter');
const pePeriodSelect = document.getElementById('pePeriodSelect');
const peGranularitySelect = document.getElementById('peGranularitySelect');
const peProductsBody = document.getElementById('peProductsBody');
const peListStatus = document.getElementById('peListStatus');
const pePageInfo = document.getElementById('pePageInfo');
const pePrevBtn = document.getElementById('pePrevBtn');
const peNextBtn = document.getElementById('peNextBtn');
const peCountsBadge = document.getElementById('peCountsBadge');
const peBootstrapBtn = document.getElementById('peBootstrapBtn');

const peDetailPlaceholder = document.getElementById('peDetailPlaceholder');
const peDetailContent = document.getElementById('peDetailContent');
const peDetailTitle = document.getElementById('peDetailTitle');
const peDetailStatus = document.getElementById('peDetailStatus');
const peDetailMeta = document.getElementById('peDetailMeta');
const peStatAds = document.getElementById('peStatAds');
const peStatObs = document.getElementById('peStatObs');
const peStatMedian = document.getElementById('peStatMedian');
const peStatMean = document.getElementById('peStatMean');
const peStatMin = document.getElementById('peStatMin');
const peStatMax = document.getElementById('peStatMax');
const peStatDisp = document.getElementById('peStatDisp');
const peStatEvo = document.getElementById('peStatEvo');
const peQualityNote = document.getElementById('peQualityNote');
const peSeriesEmpty = document.getElementById('peSeriesEmpty');
const peSegments = document.getElementById('peSegments');
const peAliases = document.getElementById('peAliases');
const peIncludedBody = document.getElementById('peIncludedBody');
const peIncludedCount = document.getElementById('peIncludedCount');
const peExcludedBody = document.getElementById('peExcludedBody');
const peExcludedCount = document.getElementById('peExcludedCount');

const pePendingCount = document.getElementById('pePendingCount');
const pePendingToggle = document.getElementById('pePendingToggle');
const pePendingBody = document.getElementById('pePendingBody');

// ─── État local de l'onglet ──────────────────────────────────────────────────
let pePage = 1;
const PE_PAGE_SIZE = 50;
let peSelectedProductId = null;
let peSeriesChart = null;
let peLoadedOnce = false;
let pePendingShown = false;

// ─── Helpers d'affichage ─────────────────────────────────────────────────────
const PE_EMPTY = '—';

function peMoney(v) {
  return Number.isFinite(v) ? `${v.toLocaleString('fr-FR')} €` : PE_EMPTY;
}

function peNum(v) {
  return Number.isFinite(v) ? v.toLocaleString('fr-FR') : PE_EMPTY;
}

function peDate(iso) {
  if (!iso) return PE_EMPTY;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return PE_EMPTY;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PE_CONDITION_LABELS = {
  new: 'Neuf',
  used: 'Occasion',
  for_parts: 'Hors service / à réparer',
  unknown: 'État inconnu',
};
const PE_OFFER_LABELS = {
  single: 'Produit seul',
  lot: 'Lot',
  with_accessories: 'Avec accessoires',
  accessory_only: 'Accessoire seul',
  part: 'Pièce détachée',
  quantity: 'Vente en quantité',
};
const PE_STATUS_LABELS = { confirmed: 'Confirmé', provisional: 'Provisoire' };
const PE_CONFIDENCE_LABELS = { high: 'Élevée', medium: 'Moyenne', low: 'Faible', insufficient: 'Insuffisante' };
const PE_CONFIDENCE_CLASSES = { high: 'pe-conf-high', medium: 'pe-conf-medium', low: 'pe-conf-low', insufficient: 'pe-conf-none' };

function peEvolutionCell(evo) {
  if (!evo || evo.direction == null) return `<span class="pe-evo-flat">${PE_EMPTY}</span>`;
  const sign = evo.absolute > 0 ? '+' : '';
  const pct = evo.percent == null ? '' : ` (${sign}${evo.percent} %)`;
  const cls = evo.direction === 'baisse' ? 'pe-evo-down' : evo.direction === 'hausse' ? 'pe-evo-up' : 'pe-evo-flat';
  return `<span class="${cls}">${sign}${peMoney(evo.absolute)}${pct}</span>`;
}

// ─── Chargement principal ────────────────────────────────────────────────────
async function loadPriceEvolutionPage() {
  peEmptyState.classList.add('hidden');
  try {
    const stats = await window.api.historyStats();
    if (!stats || stats.ok === false) {
      showPeEmptyState(stats && stats.error ? stats.error : 'Base historique indisponible.');
      return;
    }
    const counts = stats.counts || { ads: 0, products: 0, observations: 0, pending: 0 };
    peCountsBadge.textContent = `${peNum(counts.products)} produit(s) · ${peNum(counts.ads)} annonce(s) · ${peNum(counts.observations)} observation(s)`;
    peCountsBadge.classList.remove('hidden');

    if (!peLoadedOnce) {
      peLoadedOnce = true;
      // Premier affichage : on intègre les sessions DÉJÀ présentes (idempotent)
      // pour que l'utilisateur n'ait pas à relancer un scraping.
      if (counts.products === 0 && counts.ads === 0) {
        const boot = await window.api.historyBootstrap();
        if (boot && boot.ok) {
          await loadPriceEvolutionPage();
          return;
        }
      }
    }

    populatePeFamilies(stats.families || []);
    await loadPeProducts();
    await loadPePending();
  } catch (err) {
    showPeEmptyState('Erreur de chargement : ' + (err.message || err));
  }
}

function showPeEmptyState(message) {
  peEmptyState.textContent = message;
  peEmptyState.classList.remove('hidden');
  peProductsBody.innerHTML = '';
  peListStatus.textContent = '';
}

function populatePeFamilies(families) {
  const current = peFamilyFilter.value;
  const opts = ['<option value="">Toutes les familles</option>']
    .concat(families.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`));
  peFamilyFilter.innerHTML = opts.join('');
  if (current) peFamilyFilter.value = current;
}

async function loadPeProducts() {
  const opts = {
    limit: PE_PAGE_SIZE,
    offset: (pePage - 1) * PE_PAGE_SIZE,
    granularity: peGranularitySelect.value || 'day',
  };
  const q = peSearch.value.trim();
  if (q) opts.q = q;
  if (peFamilyFilter.value) opts.family = peFamilyFilter.value;

  const res = await window.api.historyListProducts(opts);
  if (!res || res.ok === false) {
    showPeEmptyState(res && res.error ? res.error : 'Impossible de lire la base historique.');
    return;
  }
  const products = res.products || [];
  if (products.length === 0 && pePage === 1) {
    peProductsBody.innerHTML = '';
    peListStatus.textContent = '';
    showPeEmptyState(q || peFamilyFilter.value
      ? 'Aucun produit ne correspond à ces filtres.'
      : 'Aucun produit identifié pour le moment. Lancez une collecte dans l\'onglet Scraper, ou cliquez sur « Importer les sessions existantes ».');
    pePageInfo.textContent = '';
    return;
  }

  renderPeProducts(products);
  peListStatus.textContent = `${products.length} affiché(s)`;
  pePageInfo.textContent = `Page ${pePage}`;
  pePrevBtn.disabled = pePage <= 1;
  peNextBtn.disabled = products.length < PE_PAGE_SIZE;
}

function renderPeProducts(products) {
  const rows = products.map((p) => {
    const conf = (p.quality && p.quality.confidence) || 'insufficient';
    const selected = peSelectedProductId === p.id ? ' pe-row-selected' : '';
    return `<tr class="pe-row${selected}" data-action="peSelectProduct" data-id="${escapePath(String(p.id))}">
      <td><span class="pe-prod-label">${escapeHtml(p.label || 'Produit non identifié')}</span>${p.brand ? ` <span class="pe-prod-brand">${escapeHtml(p.brand)}</span>` : ''}</td>
      <td>${p.reference ? escapeHtml(p.reference) : PE_EMPTY}</td>
      <td>${peNum(p.distinctAds)}</td>
      <td>${peMoney(p.median)}</td>
      <td>${peEvolutionCell(p.evolution)}</td>
      <td>${peDate(p.lastObservedAt)}</td>
      <td><span class="pe-conf ${PE_CONFIDENCE_CLASSES[conf] || ''}">${PE_CONFIDENCE_LABELS[conf] || conf}</span></td>
    </tr>`;
  });
  peProductsBody.innerHTML = rows.join('');
}

// ─── Fiche produit ───────────────────────────────────────────────────────────
async function selectPeProduct(productId) {
  peSelectedProductId = Number(productId);
  renderPeProductsSelection();
  const res = await window.api.historyProductDetail(peSelectedProductId, {
    granularity: peGranularitySelect.value || 'day',
  });
  if (!res || res.ok === false) {
    showToast(res && res.error ? res.error : 'Fiche produit indisponible.', 'error');
    return;
  }
  renderPeDetail(res);
}

function renderPeProductsSelection() {
  for (const tr of peProductsBody.querySelectorAll('tr.pe-row')) {
    const isSel = Number(tr.dataset.id) === peSelectedProductId;
    tr.classList.toggle('pe-row-selected', isSel);
  }
}

function renderPeDetail(detail) {
  const product = detail.product || {};
  const stats = detail.stats || {};
  const overall = stats.overall || {};
  const quality = stats.quality || {};

  peDetailPlaceholder.classList.add('hidden');
  peDetailContent.classList.remove('hidden');

  peDetailTitle.textContent = product.label || 'Produit non identifié';
  peDetailStatus.textContent = PE_STATUS_LABELS[product.status] || product.status || '';
  peDetailStatus.className = 'badge pe-status-badge ' + (product.status === 'confirmed' ? 'pe-status-confirmed' : 'pe-status-provisional');

  const metaBits = [];
  if (product.reference) metaBits.push(`Référence : ${product.reference}`);
  if (product.brand) metaBits.push(`Marque : ${product.brand}`);
  if (product.family) metaBits.push(`Famille : ${product.family}`);
  const units = product.units || {};
  const cap = units.capacity_gb || units.capacity_tb;
  if (cap) metaBits.push(`Capacité : ${cap.value} ${cap.unit}`);
  peDetailMeta.textContent = metaBits.join(' · ') || 'Aucune caractéristique structurée identifiée.';

  peStatAds.textContent = peNum(stats.distinctAds);
  peStatObs.textContent = peNum(stats.observationsCount);
  peStatMedian.textContent = peMoney(overall.median);
  peStatMean.textContent = peMoney(overall.mean);
  peStatMin.textContent = peMoney(overall.min);
  peStatMax.textContent = peMoney(overall.max);
  peStatDisp.textContent = overall.stdDev == null ? PE_EMPTY : `${overall.stdDev.toLocaleString('fr-FR')} €`;
  const evo = stats.evolution || {};
  peStatEvo.innerHTML = peEvolutionCell(evo);

  // Note de qualité : honnête sur le volume et la fraîcheur, sans promettre de
  // précision statistique non démontrée.
  const qParts = [];
  qParts.push(`Fiabilité : ${PE_CONFIDENCE_LABELS[quality.confidence] || quality.confidence || PE_EMPTY} (${peNum(stats.distinctAds)} annonce(s) distincte(s))`);
  if (quality.freshnessDays != null) qParts.push(`dernière observation il y a ${quality.freshnessDays} j`);
  if (quality.excludedObservations > 0) qParts.push(`${quality.excludedObservations} prix écarté(s)`);
  if (!stats.sufficient) qParts.push('données de prix insuffisantes');
  peQualityNote.textContent = qParts.join(' · ');

  renderPeSegments(stats.segments || {});
  renderPeAliases(detail.aliases || []);
  renderPeIncluded(detail.includedAds || []);
  renderPeExcluded(detail.excludedAds || []);
  renderPeSeries(stats.series || { points: [] });
}

function renderPeSegments(segments) {
  const byCondition = segments.byCondition || {};
  const byOffer = segments.byOfferType || {};
  const cards = [];
  for (const [k, s] of Object.entries(byCondition)) {
    if (!s || s.count === 0) continue;
    cards.push(`<div class="pe-segment"><span class="pe-segment-title">${escapeHtml(PE_CONDITION_LABELS[k] || k)}</span>
      <span class="pe-segment-value">${peMoney(s.median)}</span>
      <span class="pe-segment-sub">${peNum(s.ads || s.count)} annonce(s) · moy. ${peMoney(s.mean)}</span></div>`);
  }
  for (const [k, s] of Object.entries(byOffer)) {
    if (!s || s.count === 0) continue;
    cards.push(`<div class="pe-segment"><span class="pe-segment-title">${escapeHtml(PE_OFFER_LABELS[k] || k)}</span>
      <span class="pe-segment-value">${peMoney(s.median)}</span>
      <span class="pe-segment-sub">${peNum(s.ads || s.count)} annonce(s)</span></div>`);
  }
  peSegments.innerHTML = cards.length ? cards.join('') : '<p class="pe-inline-empty">Aucun segment avec des prix exploitables.</p>';
}

function renderPeAliases(aliases) {
  if (!aliases.length) { peAliases.innerHTML = '<p class="pe-inline-empty">Aucun alias enregistré.</p>'; return; }
  peAliases.innerHTML = aliases.map((a) =>
    `<span class="pe-alias" title="Source : ${escapeHtml(a.source || 'observé')}">${escapeHtml(a.alias)}</span>`).join('');
}

function renderPeIncluded(ads) {
  peIncludedCount.textContent = String(ads.length);
  if (!ads.length) { peIncludedBody.innerHTML = `<tr><td colspan="5" class="pe-inline-empty">Aucune annonce associée.</td></tr>`; return; }
  peIncludedBody.innerHTML = ads.map((a) => `<tr>
    <td>${a.url ? `<a href="#" class="pe-ad-link" data-action="openUrl" data-url="${escapePath(a.url)}">${escapeHtml(a.title || a.id)}</a>` : escapeHtml(a.title || a.id)}</td>
    <td>${peMoney(a.price)}</td>
    <td>${escapeHtml(PE_CONDITION_LABELS[a.condition] || a.condition || PE_EMPTY)}</td>
    <td>${escapeHtml(PE_OFFER_LABELS[a.offerType] || a.offerType || PE_EMPTY)}</td>
    <td>${peDate(a.lastSeen)}</td>
  </tr>`).join('');
}

function renderPeExcluded(ads) {
  peExcludedCount.textContent = String(ads.length);
  if (!ads.length) { peExcludedBody.innerHTML = `<tr><td colspan="2" class="pe-inline-empty">Aucune annonce exclue.</td></tr>`; return; }
  const REASON_LABELS = {
    offer_type_incompatible: 'Type d\'offre incompatible (lot, accessoire, pièce)',
    reference_model_variant: 'Référence de modèle différente',
    reference_incompatible: 'Référence incompatible',
    family_incompatible: 'Famille de produit différente',
    units_incompatible: 'Caractéristiques incompatibles',
    ad_condition_title_description: 'Contradiction titre / description',
    ad_reference_title_description: 'Contradiction de référence titre / description',
    offer_with_accessories: 'Vendu avec accessoires (à vérifier)',
  };
  peExcludedBody.innerHTML = ads.map((a) => `<tr>
    <td>${escapeHtml(a.title || a.id)}</td>
    <td>${a.reasons && a.reasons.length ? a.reasons.map((r) => escapeHtml(REASON_LABELS[r] || r)).join(', ') : 'Motif non enregistré'}</td>
  </tr>`).join('');
}

function renderPeSeries(series) {
  const canvas = document.getElementById('peSeriesChart');
  const points = (series && series.points) || [];
  if (peSeriesChart) { peSeriesChart.destroy(); peSeriesChart = null; }
  if (!canvas) return;

  if (points.length === 0) {
    peSeriesEmpty.classList.remove('hidden');
    return;
  }
  peSeriesEmpty.classList.add('hidden');
  if (typeof Chart === 'undefined') return;

  const css = (name, fallback) => (getComputedStyle(document.body).getPropertyValue(name).trim() || fallback);
  const C = {
    primary: css('--primary-color', '#5fa79d'),
    muted: css('--text-muted', '#9aa1ac'),
    text: css('--text-color', '#e6e8ec'),
    grid: css('--border-color', '#313640'),
    accent: css('--accent-muted', '#b8a06a'),
    tooltipBg: css('--card-bg', '#212429'),
  };

  const labels = points.map((p) => p.period);
  const medians = points.map((p) => p.median);
  const means = points.map((p) => p.mean);
  const volumes = points.map((p) => p.ads);

  peSeriesChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Prix médian',
          data: medians,
          borderColor: C.primary,
          backgroundColor: 'transparent',
          tension: 0.25,
          spanGaps: false,
          pointRadius: 3,
          yAxisID: 'y',
        },
        {
          label: 'Prix moyen',
          data: means,
          borderColor: C.accent,
          backgroundColor: 'transparent',
          borderDash: [5, 4],
          tension: 0.25,
          spanGaps: false,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Annonces',
          data: volumes,
          type: 'bar',
          backgroundColor: C.grid,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: C.text } },
        tooltip: {
          backgroundColor: C.tooltipBg, titleColor: C.text, bodyColor: C.text, padding: 12, cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.yAxisID === 'y1') return `${ctx.dataset.label} : ${ctx.parsed.y}`;
              return `${ctx.dataset.label} : ${Number.isFinite(ctx.parsed.y) ? ctx.parsed.y.toLocaleString('fr-FR') + ' €' : PE_EMPTY}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: C.muted, maxRotation: 0, autoSkip: true }, grid: { color: C.grid } },
        y: { position: 'left', ticks: { color: C.muted }, grid: { color: C.grid }, title: { display: true, text: 'Prix (€)', color: C.muted } },
        y1: { position: 'right', beginAtZero: true, ticks: { precision: 0, color: C.muted }, grid: { display: false }, title: { display: true, text: 'Annonces', color: C.muted } },
      },
    },
  });
}

// ─── File des rapprochements incertains ──────────────────────────────────────
async function loadPePending() {
  const res = await window.api.historyListPending({ limit: 100, offset: 0 });
  const pending = (res && res.pending) || [];
  pePendingCount.textContent = String(pending.length);
  if (!pePendingShown) return;
  renderPePending(pending);
}

function renderPePending(pending) {
  if (!pending.length) {
    pePendingBody.innerHTML = '<p class="pe-inline-empty">Aucune correspondance en attente de vérification.</p>';
    return;
  }
  pePendingBody.innerHTML = pending.map((p) => {
    const cands = (p.candidates || []).filter((c) => c.productId).slice(0, 5);
    const candHtml = cands.length
      ? cands.map((c) => `<button class="btn btn-secondary btn-small pe-cand-btn" data-action="peConfirmCandidate" data-ad="${escapePath(String(p.adId))}" data-product="${escapePath(String(c.productId))}" title="Associer à ce produit">${escapeHtml(c.label || c.reference || ('#' + c.productId))} <span class="pe-cand-score">${c.score}</span></button>`).join('')
      : '<span class="pe-inline-empty">Aucun produit candidat</span>';
    return `<div class="pe-pending-item">
      <div class="pe-pending-head">
        <span class="pe-pending-title">${escapeHtml(p.title || ('Annonce #' + p.adId))}</span>
        <span class="pe-pending-badge">${p.decision === 'rejected' ? 'Écarté' : 'Incertain'} · score ${p.score}</span>
      </div>
      ${p.reference ? `<p class="pe-pending-meta">Référence détectée : ${escapeHtml(p.reference)}${p.family ? ' · famille : ' + escapeHtml(p.family) : ''}</p>` : ''}
      ${p.description ? `<p class="pe-pending-desc">${escapeHtml(p.description)}</p>` : ''}
      <div class="pe-pending-cands">${candHtml}</div>
      <div class="pe-pending-actions">
        <button class="btn btn-primary btn-small" data-action="peCreateIdentity" data-ad="${escapePath(String(p.adId))}">Créer une identité provisoire</button>
        <button class="btn btn-secondary btn-small" data-action="peRejectAd" data-ad="${escapePath(String(p.adId))}">Déclarer différent</button>
        ${p.url ? `<button class="btn btn-secondary btn-small" data-action="openUrl" data-url="${escapePath(p.url)}">Voir l'annonce</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── Actions (délégation d'événements) ───────────────────────────────────────
window.peSelectProduct = selectPeProduct;

window.peConfirmCandidate = async (adId, productId) => {
  const res = await window.api.historyCorrect({ adId: Number(adId), action: 'confirm', productId: Number(productId) });
  if (res && res.ok) {
    showToast('Correspondance confirmée. Statistiques recalculées.', 'success');
    await refreshPeAfterCorrection();
  } else {
    showToast((res && res.error) || 'Correction impossible.', 'error');
  }
};

window.peCreateIdentity = async (adId) => {
  const res = await window.api.historyCorrect({ adId: Number(adId), action: 'create' });
  if (res && res.ok) {
    showToast('Identité provisoire créée.', 'success');
    await refreshPeAfterCorrection();
  } else {
    showToast((res && res.error) || 'Création impossible.', 'error');
  }
};

window.peRejectAd = async (adId) => {
  const res = await window.api.historyCorrect({ adId: Number(adId), action: 'reject' });
  if (res && res.ok) {
    showToast('Annonce déclarée différente (exclue des séries).', 'success');
    await refreshPeAfterCorrection();
  } else {
    showToast((res && res.error) || 'Correction impossible.', 'error');
  }
};

async function refreshPeAfterCorrection() {
  const stats = await window.api.historyStats();
  if (stats && stats.ok) {
    const c = stats.counts || {};
    peCountsBadge.textContent = `${peNum(c.products)} produit(s) · ${peNum(c.ads)} annonce(s) · ${peNum(c.observations)} observation(s)`;
  }
  await loadPeProducts();
  await loadPePending();
  if (peSelectedProductId) await selectPeProduct(peSelectedProductId);
}

// Délégation : évite les onclick inline (données non fiables dans les attributs).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'peSelectProduct') { e.preventDefault(); window.peSelectProduct(el.dataset.id); }
  else if (action === 'peConfirmCandidate') { e.preventDefault(); window.peConfirmCandidate(el.dataset.ad, el.dataset.product); }
  else if (action === 'peCreateIdentity') { e.preventDefault(); window.peCreateIdentity(el.dataset.ad); }
  else if (action === 'peRejectAd') { e.preventDefault(); window.peRejectAd(el.dataset.ad); }
});

// ─── Écouteurs des filtres ───────────────────────────────────────────────────
peSearch.addEventListener('input', debounce(() => { pePage = 1; loadPeProducts(); }, 250));
peFamilyFilter.addEventListener('change', () => { pePage = 1; loadPeProducts(); });
pePeriodSelect.addEventListener('change', () => { if (peSelectedProductId) selectPeProduct(peSelectedProductId); });
peGranularitySelect.addEventListener('change', () => {
  pePage = 1;
  loadPeProducts();
  if (peSelectedProductId) selectPeProduct(peSelectedProductId);
});
pePrevBtn.addEventListener('click', () => { if (pePage > 1) { pePage--; loadPeProducts(); } });
peNextBtn.addEventListener('click', () => { pePage++; loadPeProducts(); });

peBootstrapBtn.addEventListener('click', async () => {
  peBootstrapBtn.disabled = true;
  peBootstrapBtn.textContent = 'Import en cours…';
  try {
    const res = await window.api.historyBootstrap();
    if (res && res.ok) {
      showToast(`Import terminé : ${res.jobs} session(s), ${res.ads} annonce(s) traitée(s).`, 'success');
      pePage = 1;
      await loadPriceEvolutionPage();
    } else {
      showToast((res && res.error) || 'Import impossible.', 'error');
    }
  } catch (err) {
    showToast('Import impossible : ' + (err.message || err), 'error');
  } finally {
    peBootstrapBtn.disabled = false;
    peBootstrapBtn.textContent = 'Importer les sessions existantes';
  }
});

pePendingToggle.addEventListener('click', async () => {
  pePendingShown = !pePendingShown;
  pePendingToggle.textContent = pePendingShown ? 'Masquer' : 'Afficher';
  pePendingBody.classList.toggle('hidden', !pePendingShown);
  if (pePendingShown) await loadPePending();
});

// Les graphiques figent leurs couleurs : on reconstruit la série au changement
// de thème (comme les autres onglets).
document.addEventListener('themechange', () => {
  if (document.getElementById('tab-price-evolution')?.classList.contains('active') && peSelectedProductId) {
    selectPeProduct(peSelectedProductId);
  }
});
