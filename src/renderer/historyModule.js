const historyTableBody = document.getElementById('historyTableBody');
const openMainFolderBtn = document.getElementById('openMainFolderBtn');

// PAGE 3 : HISTORIQUE
async function loadHistoryPage() {
  try {
    allJobsCache = await window.api.getHistory();
    renderHistoryTable(allJobsCache);
  } catch (err) {
    historyTableBody.innerHTML = `<tr><td colspan="4" class="text-center">Erreur : ${escapeHtml(err && err.message ? err.message : 'inconnue')}</td></tr>`;
  }
}

function renderHistoryTable(jobs) {
  if (!jobs || jobs.length === 0) {
    historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center">Aucun scraping trouvé dans le dossier de résultats.</td></tr>';
    return;
  }

  historyTableBody.innerHTML = jobs
    .map(
      (j) => `
    <tr>
      <td>${escapeHtml(j.date)}${(j.exportMeta && ((j.exportMeta.profileId || j.exportMeta.exportMode) === 'custom')) ? '<br><span class="tag-export-custom" title="Mode Personnalisé : uniquement les champs sélectionnés">Personnalisé</span>' : ''}</td>
      <td><strong>${escapeHtml(String(j.adsCount))}</strong> annonces</td>
      <td>${renderSessionStatus(j)}</td>
      <td>
        <div class="file-tags">
          ${j.files.json ? `<span class="file-tag" data-action="openFile" data-id="${escapeHtml(j.files.json)}">JSON</span>` : ''}
          ${j.files.txt ? `<span class="file-tag tag-txt" data-action="openFile" data-id="${escapeHtml(j.files.txt)}">TXT</span>` : ''}
        </div>
      </td>
      <td>
        <div class="history-actions">
          ${j.id ? `<button class="btn btn-secondary btn-small" data-action="openSessionFolder" data-id="${escapeHtml(j.id)}" title="Ouvrir le dossier de résultats de cette session">Ouvrir le dossier</button>` : ''}
          ${j.id ? `<button class="btn btn-danger btn-small" data-action="askDeleteJob" data-id="${escapeHtml(j.id)}" title="Supprimer cette session">Supprimer</button>` : ''}
        </div>
      </td>
    </tr>
  `
    )
    .join('');
}

/**
 * Badge de statut d'une session, déduit des informations réellement
 * disponibles (exit code du pipeline, nombre d'annonces, intégrité). Aucun
 * statut n'est inventé : en l'absence d'information exploitable, on affiche un
 * état neutre.
 * @param {object} j job issu de l'historique
 * @returns {string} HTML du badge
 */
function renderSessionStatus(j) {
  const dur = (j.durationMs != null && Number.isFinite(j.durationMs))
    ? ` <span class="text-muted font-small">· ${formatDurationShort(j.durationMs)}</span>` : '';
  if (j.integrityWarning) {
    return `<span class="session-badge badge-error" title="Intégrité des données compromise">Intégrité douteuse</span>${dur}`;
  }
  // exitCode 3 = enrichissement arrêté (403), 4 = 429 → succès partiel.
  if (j.exitCode === 3 || j.exitCode === 4) {
    return `<span class="session-badge badge-warn" title="Enrichissement interrompu par le site (HTTP ${j.exitCode === 4 ? '429' : '403'})">Partiel</span>${dur}`;
  }
  if (j.exitCode === 1 || j.exitCode === 2) {
    return `<span class="session-badge badge-error" title="Session sans données exploitables">Échec</span>${dur}`;
  }
  if (j.adsCount > 0) {
    return `<span class="session-badge badge-success">Terminé</span>${dur}`;
  }
  return `<span class="session-badge badge-neutral">Inconnu</span>${dur}`;
}

/** Formate une durée en millisecondes (ex: 12500 → « 12 s », 95000 → « 1 min 35 s »). */
function formatDurationShort(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m} min ${s} s`;
}

window.askDeleteJob = (jobId) => {
  pendingDeleteJobId = jobId;
  modalMessage.textContent = `Voulez-vous vraiment supprimer définitivement le scraping "${jobId}" ?`;
  confirmModal.classList.remove('hidden');
};

modalCancelBtn.addEventListener('click', () => {
  confirmModal.classList.add('hidden');
  pendingDeleteJobId = null;
});

modalConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteJobId || isConfirming) return;
  const jobId = pendingDeleteJobId;
  isConfirming = true;
  modalConfirmBtn.disabled = true;
  try {
    await window.api.deleteJob(jobId);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
    // Rafraîchit l'onglet de données actif (Historique, Explorateur ou Stats).
    // Avant, seul l'historique était rafraîchi ; si l'utilisateur supprimait un
    // job depuis l'historique puis allait sur l'Explorateur, le sessionSelect
    // pouvait encore référencer le job supprimé (phantom) jusqu'au prochain
    // getHistory. refreshActiveDataTab couvre les 3 onglets de données.
    await loadHistoryPage();
    // Nettoie le comparateur : les ads du job supprimé ne sont plus dans
    // allJobsCache. Sans cela, compareCount affichait un nombre supérieur aux
    // colonnes réellement affichables (IDs fantômes).
    if (compareSet.size > 0) {
      const validIds = new Set();
      allJobsCache.forEach((j) => {
        if (Array.isArray(j.ads)) j.ads.forEach((a) => validIds.add(String(a.id)));
      });
      compareSet = new Set([...compareSet].filter((id) => validIds.has(id)));
      compareCount.textContent = compareSet.size;
    }
    refreshActiveDataTab();
  } catch (err) {
    console.error('[confirmDelete] Échec suppression :', err);
    confirmModal.classList.add('hidden');
    pendingDeleteJobId = null;
  } finally {
    isConfirming = false;
    modalConfirmBtn.disabled = false;
  }
});

openMainFolderBtn.addEventListener('click', async () => {
  try {
    // Ouvrir le dossier results/ (JOBS_DIR) qui contient les résultats du scraping
    const res = await window.api.openJobsFolder();
    if (res && res.success === false) {
      showToast('Impossible d\'ouvrir le dossier results : ' + (res.error || 'erreur inconnue'), 'error');
    }
  } catch (err) {
    showToast('Impossible d\'ouvrir le dossier results : ' + (err.message || err), 'error');
  }
});
