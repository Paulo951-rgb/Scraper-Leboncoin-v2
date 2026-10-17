const statTotalAds = document.getElementById('statTotalAds');
const statAvgPrice = document.getElementById('statAvgPrice');
const statMedPrice = document.getElementById('statMedPrice');
const statMinPrice = document.getElementById('statMinPrice');
const statMaxPrice = document.getElementById('statMaxPrice');
const statHandDelivery = document.getElementById('statHandDelivery');
const statLivraison = document.getElementById('statLivraison');
const statDeliveryTypeDist = document.getElementById('statDeliveryTypeDist');

const statPro = document.getElementById('statPro');
const statPart = document.getElementById('statPart');

// PAGE STATISTIQUES & CARTE LEAFLET
async function loadStatsPage() {
  allJobsCache = await window.api.getHistory();
  populateSessionDropdown(statsSessionSelect);
  renderStatsView();
}

statsSessionSelect.addEventListener('change', renderStatsView);

function renderStatsView() {
  const selectedJobId = statsSessionSelect.value;
  let sourceAds = [];

  if (selectedJobId === 'ALL') {
    allJobsCache.forEach((j) => {
      if (Array.isArray(j.ads)) sourceAds.push(...j.ads);
    });
  } else {
    const found = allJobsCache.find((j) => j.id === selectedJobId);
    if (found && Array.isArray(found.ads)) sourceAds = found.ads;
  }

  // Extraction robuste des prix : gère number, string avec format FR/EN
  const prices = [];
  for (const a of sourceAds) {
    const raw = a.prix ?? a.price;
    if (raw == null || raw === '') continue;
    let n;
    if (typeof raw === 'number') {
      n = Number.isFinite(raw) ? raw : NaN;
    } else if (typeof raw === 'string') {
      n = parseFloat(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    } else {
      n = NaN;
    }
    if (Number.isFinite(n) && n > 0) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('fr-FR') : '-');

  statTotalAds.textContent = sourceAds.length;

  if (prices.length > 0) {
    const sum = prices.reduce((s, p) => s + p, 0);
    const avg = Math.round(sum / prices.length);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 !== 0 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2);

    statAvgPrice.textContent = fmt(avg) + ' €';
    if (statMedPrice) statMedPrice.textContent = fmt(median) + ' €';
    statMinPrice.textContent = fmt(prices[0]) + ' €';
    statMaxPrice.textContent = fmt(prices[prices.length - 1]) + ' €';
  } else {
    statAvgPrice.textContent = '-';
    if (statMedPrice) statMedPrice.textContent = '-';
    statMinPrice.textContent = '-';
    statMaxPrice.textContent = '-';
  }

  // Statistiques deliveryType (modèle unifié)
  let livraisonCount = 0;
  let mainPropreCount = 0;
  let lesDeuxCount = 0;
  let aucunCount = 0;
  let inconnuCount = 0;
  let nonRenseigneCount = 0;

  for (const a of sourceAds) {
    let dt = a.deliveryType;
    if (!dt) {
      const livraison = a.livraison ?? a.shipping;
      const mainPropre = a.mainPropre ?? a.handDelivery;
      // Doit reproduire computeDeliveryType : false + null → aucun (pas inconnu),
      // sinon l'onglet Stats diverge de l'explorateur et de la fiche annonce.
      if (livraison === true && mainPropre === true) dt = 'les_deux';
      else if (livraison === true) dt = 'livraison';
      else if (mainPropre === true) dt = 'main_propre';
      else if (livraison === false || mainPropre === false) dt = 'aucun';
      else dt = 'inconnu';
    }
    if (dt === 'livraison') livraisonCount++;
    else if (dt === 'main_propre') mainPropreCount++;
    else if (dt === 'les_deux') lesDeuxCount++;
    else if (dt === 'aucun') aucunCount++;
    else { inconnuCount++; nonRenseigneCount++; }
  }

  const proCount = sourceAds.filter((a) => a.vendeurType === 'pro').length;
  const partCount = sourceAds.length - proCount;

  // Cartes livraison / main propre : compte les annonces qui proposent ce mode
  // (livraison seule OU les_deux pour livraison ; main_propre seule OU les_deux pour main propre)
  statHandDelivery.textContent = fmt(mainPropreCount + lesDeuxCount);
  statLivraison.textContent = fmt(livraisonCount + lesDeuxCount);
  if (statDeliveryTypeDist) {
    statDeliveryTypeDist.textContent = `${fmt(livraisonCount)} / ${fmt(mainPropreCount)} / ${fmt(lesDeuxCount)} / ${fmt(aucunCount)} / ${fmt(inconnuCount)}`;
  }
  statPro.textContent = fmt(proCount);
  statPart.textContent = fmt(partCount);

  renderCharts(sourceAds, { livraisonCount, mainPropreCount, lesDeuxCount, aucunCount, inconnuCount, nonRenseigneCount });
}

// La carte géographique est désormais dans son propre onglet (mapModule.js).

function renderCharts(ads, transactionStats) {
  // Garde contre les canvas absents du DOM
  const priceDistCanvas = document.getElementById('priceDistChart');
  const sellerCanvas = document.getElementById('sellerChart');
  const citiesCanvas = document.getElementById('topCitiesChart');
  const transactionCanvas = document.getElementById('transactionChart');
  if (!priceDistCanvas || !sellerCanvas || !citiesCanvas || !transactionCanvas) return;

  // Aucune donnée (ou Chart.js indisponible) : on DÉTRUIT les instances
  // existantes pour ne pas laisser à l'écran les graphiques de la session
  // précédente (données fantômes). L'ancien early-return laissait les anciens
  // graphiques affichés quand on bascule sur une session sans annonces.
  if (typeof Chart === 'undefined' || ads.length === 0) {
    if (priceDistChartInstance) { priceDistChartInstance.destroy(); priceDistChartInstance = null; }
    if (sellerChartInstance) { sellerChartInstance.destroy(); sellerChartInstance = null; }
    if (topCitiesChartInstance) { topCitiesChartInstance.destroy(); topCitiesChartInstance = null; }
    if (transactionChartInstance) { transactionChartInstance.destroy(); transactionChartInstance = null; }
    return;
  }

  // 1) Distribution des prix (histogramme)
  const prices = [];
  for (const a of ads) {
    const raw = a.prix ?? a.price;
    if (raw == null || raw === '') continue;
    let n;
    if (typeof raw === 'number') {
      n = Number.isFinite(raw) ? raw : NaN;
    } else if (typeof raw === 'string') {
      n = parseFloat(raw.replace(/\s/g, '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    } else {
      n = NaN;
    }
    if (Number.isFinite(n) && n > 0) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  const priceDistCtx = priceDistCanvas.getContext('2d');
  if (priceDistChartInstance) priceDistChartInstance.destroy();

  if (prices.length > 0) {
    const maxPrice = prices[prices.length - 1];
    // Bornes adaptatives : jusqu'à 8 tranches
    const bucketCount = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(prices.length))));
    const bucketSize = Math.max(1, Math.ceil(maxPrice / bucketCount));
    const buckets = new Array(bucketCount).fill(0);
    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
      const lo = i * bucketSize;
      const hi = (i + 1) * bucketSize;
      labels.push(lo === 0 ? `0–${hi} €` : `${lo}–${hi} €`);
    }
    for (const p of prices) {
      let idx = Math.floor(p / bucketSize);
      if (idx >= bucketCount) idx = bucketCount - 1;
      buckets[idx]++;
    }
    priceDistChartInstance = new Chart(priceDistCtx, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Nombre d\'annonces', data: buckets, backgroundColor: '#38bdf8', borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { title: { display: true, text: 'Distribution des Prix' }, legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // 2) Vendeurs particuliers vs pros — barres horizontales comparatives
  // (remplace le camembert/doughnut peu lisible pour comparer 2 valeurs).
  const proCount = ads.filter((a) => a.vendeurType === 'pro').length;
  const partCount = ads.length - proCount;
  const total = partCount + proCount;
  const partPct = total ? Math.round((partCount / total) * 100) : 0;
  const proPct = total ? 100 - partPct : 0;
  const sellerCtx = sellerCanvas.getContext('2d');
  if (sellerChartInstance) sellerChartInstance.destroy();

  sellerChartInstance = new Chart(sellerCtx, {
    type: 'bar',
    data: {
      labels: ['Particuliers', 'Professionnels'],
      datasets: [{
        label: 'Nombre d\'annonces',
        data: [partCount, proCount],
        backgroundColor: ['#38bdf8', '#8b5cf6'],
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.65,
        categoryPercentage: 0.7,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Vendeurs Particuliers vs Pros', padding: { bottom: 10 } },
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.x;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return `${ctx.label}: ${v.toLocaleString('fr-FR')} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' },
          grid: { color: 'rgba(148,163,184,0.12)' },
        },
        y: {
          ticks: { color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' },
          grid: { display: false },
        },
      },
    },
  });

  // 3) Top 10 villes par nombre d'annonces
  const cityCounts = {};
  for (const a of ads) {
    const c = (a.city || 'Inconnue').trim() || 'Inconnue';
    cityCounts[c] = (cityCounts[c] || 0) + 1;
  }
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const citiesCtx = citiesCanvas.getContext('2d');
  if (topCitiesChartInstance) topCitiesChartInstance.destroy();

  topCitiesChartInstance = new Chart(citiesCtx, {
    type: 'bar',
    data: {
      labels: topCities.map((c) => c[0]),
      datasets: [{ label: 'Annonces', data: topCities.map((c) => c[1]), backgroundColor: '#22c55e', borderRadius: 6 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: 'Top 10 Villes' }, legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        // Force l'affichage des 10 labels de villes (autoSkip désactivé, aucun
        // masquage alterné).
        y: { ticks: { autoSkip: false, maxTicksLimit: 10 } },
      },
    },
  });

  // 4) Modes de remise (deliveryType : livraison / main_propre / les_deux / aucun / inconnu)
  const tStats = transactionStats || { livraisonCount: 0, mainPropreCount: 0, lesDeuxCount: 0, aucunCount: 0, inconnuCount: 0, nonRenseigneCount: 0 };
  const transactionCtx = transactionCanvas.getContext('2d');
  if (transactionChartInstance) transactionChartInstance.destroy();

  transactionChartInstance = new Chart(transactionCtx, {
    type: 'bar',
    data: {
      labels: ['📦 Livraison', '🤝 Main propre', '📦+🤝 Les deux', '🚫 Aucun', '❓ Inconnu'],
      datasets: [{
        label: 'Nombre d\'annonces',
        data: [tStats.livraisonCount, tStats.mainPropreCount, tStats.lesDeuxCount, tStats.aucunCount || 0, tStats.inconnuCount || tStats.nonRenseigneCount || 0],
        backgroundColor: ['#38bdf8', '#22c55e', '#a855f7', '#f97316', '#64748b'],
        borderRadius: 8,
        borderSkipped: false,
        barPercentage: 0.65,
        categoryPercentage: 0.7,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Modes de Remise', padding: { bottom: 10 } },
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.parsed.x.toLocaleString('fr-FR')}`,
          },
        },
      },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { ticks: { color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#94a3b8' }, grid: { display: false } },
      },
    },
  });
}

// Écouteur pour rafraîchir la carte si on coche/décoche la remise en main propre
document.getElementById('mapHandDeliveryOnly')?.addEventListener('change', () => {
  renderStatsView();
});
