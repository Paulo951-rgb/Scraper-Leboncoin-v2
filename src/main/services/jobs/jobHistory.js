'use strict';

const fs = require('fs');
const path = require('path');
const { AdStats } = require('../analysis/adStats');
const { JOBS_DIR } = require('../../config/constants');
const { readWithChecksum } = require('../../utils/integrity');
const { parsePriceString } = require('../scraping/adFields');

/**
 * Analyse l'historique complet des jobs pour détecter les changements par
 * annonce (prix, likes, statut, présence). Pour chaque identifiant d'annonce
 * vu dans plusieurs sessions, calcule :
 *  - première date de découverte (jobId le plus ancien)
 *  - dernière date de scraping (jobId le plus récent)
 *  - changement de prix (priceDrop / priceRise / stable)
 *  - changement de likes (likesUp / likesDown / stable / likesSeen)
 *  - changement de statut (statusChange)
 *  - disparition (présent dans anciens jobs, absent dans le dernier)
 *
 * Renvoie un tableau trié par activité décroissante : les annonces avec le
 * plus de changements / la plus forte baisse de prix apparaissent en premier.
 *
 * Le résultat est volontairement compact et structuré pour exploitation JSON.
 */
function buildAdHistory(allJobs) {
  const byAd = new Map(); // id → array of { jobId, jobDate, ad }
  // Bornes anti-DoS : un annonces.json corrompu ou volontairement énorme ne doit
  // pas faire exploser la mémoire du processus principal (cette fonction est
  // appelée sur TOUTES les annonces de TOUTES les sessions). On borne donc
  // l'entrée, et on tronque les occurrences mémorisées par annonce : seules la
  // première et la dernière occurrence servent au calcul.
  const MAX_JOBS = 5000;
  const MAX_ADS_PER_JOB = 50000;
  const MAX_OCCURRENCES_PER_AD = 32;
  const jobs = Array.isArray(allJobs) ? allJobs.slice(0, MAX_JOBS) : [];
  for (const job of jobs) {
    if (!job || !Array.isArray(job.ads)) continue;
    for (const a of job.ads.slice(0, MAX_ADS_PER_JOB)) {
      if (!a || !a.id) continue;
      const id = String(a.id);
      if (!byAd.has(id)) byAd.set(id, []);
      const occ = byAd.get(id);
      if (occ.length < MAX_OCCURRENCES_PER_AD) {
        occ.push({ jobId: job.id, jobDate: job.date || job.id, ad: a });
      } else {
        // Conserve la plus récente sans faire croître la liste indéfiniment.
        occ[occ.length - 1] = { jobId: job.id, jobDate: job.date || job.id, ad: a };
      }
    }
  }

  const result = [];
  for (const [id, occurrences] of byAd.entries()) {
    // Tri chronologique. `jobDate` est une date AFFICHÉE au format FR
    // (jj/mm/aaaa) : un tri lexicographique est FAUX (01/02/2026 < 12/01/2026
    // alors que février est postérieur à janvier). On dérive donc un instant
    // fiable depuis l'horodatage ISO présent dans l'id du job (job-<ISO>), avec
    // repli sur la date FR parsée, puis sur la chaîne brute.
    const _timeOf = (o) => {
      const m = String(o.jobId || '').match(/^job-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
      if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      const fr = String(o.jobDate || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?: à (\d{2}):(\d{2}))?/);
      if (fr) return Date.parse(`${fr[3]}-${fr[2]}-${fr[1]}T${fr[4] || '00'}:${fr[5] || '00'}:00Z`);
      return NaN;
    };
    occurrences.sort((a, b) => {
      const ta = _timeOf(a);
      const tb = _timeOf(b);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return String(a.jobDate).localeCompare(String(b.jobDate));
    });
    const first = occurrences[0];
    const last = occurrences[occurrences.length - 1];

    // Prix : le modèle expose un NOMBRE, mais d'anciens jobs (ou un fichier
    // édité) peuvent contenir une chaîne au format français (« 1 250 € »,
    // « 1.299,99 »). `parseFloat` seul tronque silencieusement ces formes
    // (parseFloat('1 250 €') === 1) → aucun changement de prix détecté. On
    // réutilise parsePriceString (même convention que le pipeline/AdStats).
    const _priceOf = (ad) => {
      const raw = ad.prix ?? ad.price;
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string') return parsePriceString(raw);
      return NaN;
    };
    const priceFirst = _priceOf(first.ad);
    const priceLast = _priceOf(last.ad);
    let priceChange = null;
    if (Number.isFinite(priceFirst) && Number.isFinite(priceLast) && priceFirst !== priceLast) {
      const delta = priceLast - priceFirst;
      priceChange = {
        initial: priceFirst,
        actuel: priceLast,
        delta: delta,
        baisse: delta < 0 ? -delta : 0,
        hausse: delta > 0 ? delta : 0,
        direction: delta < 0 ? 'baisse' : (delta > 0 ? 'hausse' : 'stable'),
      };
    }

    // Likes : le modèle plat expose `likes`. On conserve des replis vers les
    // anciennes formes (`statistiques.likes`, `likes_count`) pour rester
    // compatible avec les jobs exportés par d'anciennes versions — sans ces
    // replis, la détection de changement de likes ne lisait QUE les données
    // actuelles et ignorait silencieusement les anciens jobs.
    const likesFirst = first.ad.likes ?? first.ad.statistiques?.likes ?? first.ad.likes_count ?? null;
    const likesLast = last.ad.likes ?? last.ad.statistiques?.likes ?? last.ad.likes_count ?? null;
    let likesChange = null;
    if (likesFirst != null && likesLast != null && likesFirst !== likesLast) {
      likesChange = {
        initial: likesFirst,
        actuel: likesLast,
        delta: likesLast - likesFirst,
        direction: likesLast > likesFirst ? 'up' : 'down',
      };
    }

    // Statut : le modèle actuel n'expose pas de statut ; on lit un éventuel
    // `status` plat ou l'ancien `dates.statut` (rétro-compat). En l'absence des
    // deux, statusChange reste null.
    const statusFirst = first.ad.status ?? first.ad.dates?.statut ?? null;
    const statusLast = last.ad.status ?? last.ad.dates?.statut ?? null;
    const statusChange = (statusFirst != null && statusLast != null && statusFirst !== statusLast)
      ? { avant: statusFirst, apres: statusLast }
      : null;

    result.push({
      id,
      titre: last.ad.title || first.ad.title || null,
      url: last.ad.url || first.ad.url || null,
      sessions: occurrences.length,
      jobIds: occurrences.map((o) => o.jobId),
      premiereDecouverte: first.jobDate,
      derniereMaj: last.jobDate,
      prix: priceChange,
      likes: likesChange,
      statutChange: statusChange,
      prixActuel: Number.isFinite(priceLast) ? priceLast : null,
      likesActuel: likesLast != null ? likesLast : null,
    });
  }

  // Tri : plus de changements / plus grosse baisse en premier
  result.sort((a, b) => {
    const scoreA = (a.prix?.baisse || 0) + (a.likes?.delta > 0 ? a.likes.delta : 0) + a.sessions;
    const scoreB = (b.prix?.baisse || 0) + (b.likes?.delta > 0 ? b.likes.delta : 0) + b.sessions;
    return scoreB - scoreA;
  });
  return result;
}

class JobHistoryManager {
  static getJobsDir() {
    return JOBS_DIR;
  }

  static listAllJobs() {
    const jobsDir = this.getJobsDir();
    if (!fs.existsSync(jobsDir)) {
      console.log(`[JobHistory] Dossier jobs introuvable : ${jobsDir} — retour liste vide.`);
      return [];
    }

    const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    const jobDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('job-'));
    console.log(`[JobHistory] Scan de ${jobsDir} : ${entries.length} entrée(s), ${jobDirs.length} dossier(s) job- trouvés.`);
    const jobs = [];

    for (const entry of jobDirs) {
      const jobPath = path.join(jobsDir, entry.name);
      const resultsDir = path.join(jobPath, 'results');
      const jsonPath = path.join(resultsDir, 'annonces.json');
      const txtPath = path.join(resultsDir, 'annonces.txt');
      const exportMetaPath = path.join(resultsDir, 'export-meta.json');
      const reportPath = path.join(resultsDir, 'report.json');

      let rawAds = [];
      // Formatage lisible : le nom du dossier est job-<ISO> (ex: job-2026-08-12T02-21-16-123Z).
      // On veut afficher « 12/08/2026 à 02:21 » (date française HH:MM, sans les ms ni
      // les secondes tronquées au milieu). L'ancien code remplaçait tous les '-' par
      // ':' → « 2026:08:12 à 02:21 » (deux-points dans la date, illisible).
      const tsMatch = entry.name.match(/^job-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
      const dateFormatted = tsMatch
        ? `${tsMatch[3]}/${tsMatch[2]}/${tsMatch[1]} à ${tsMatch[4]}:${tsMatch[5]}`
        : entry.name.replace('job-', '');
      let integrityWarning = null;

      if (fs.existsSync(jsonPath)) {
        const { data, valid, reason } = readWithChecksum(jsonPath);
        if (!valid) {
          console.warn(`[JobHistory] Intégrité compromise pour ${entry.name} : ${reason} — annonces ignorées.`);
          integrityWarning = reason;
          rawAds = [];
        } else {
          rawAds = data || [];
        }
      } else {
        console.debug(`[JobHistory] ${entry.name} : pas d'annonces.json (résultats absents).`);
      }

      const { stats, ads: enrichedAds } = AdStats.analyze(rawAds);

      // Rapport de session (durée par phase, mesures de performance, journal
      // réseau). Lecture tolérante : un report.json absent ou corrompu ne doit
      // pas empêcher l'affichage de l'historique.
      const report = (() => {
        try {
          if (fs.existsSync(reportPath)) {
            const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            return (r && typeof r === 'object') ? r : null;
          }
        } catch { /* silencieux : report illisible */ }
        return null;
      })();
      const durationMs = report?.performance?.totalMs != null ? report.performance.totalMs : null;

      jobs.push({
        id: entry.name,
        date: dateFormatted,
        adsCount: rawAds.length,
        stats,
        ads: enrichedAds,
        jobDir: jobPath,
        resultsDir,
        integrityWarning,
        durationMs,
        exitCode: report?.exitCode ?? null,
        reportAvailable: !!report,
        files: {
          json: fs.existsSync(jsonPath) ? jsonPath : null,
          txt: fs.existsSync(txtPath) ? txtPath : null,
        },
        // Méta-données d'export (profil Défaut/Maximum/Personnalisé + liste de
        // champs). Le pipeline écrit `profileId` (version 2) ; on retombe sur
        // `exportMode` pour les anciens jobs et on garantit `profileId` pour un
        // contrat homogène côté renderer.
        exportMeta: (() => {
          try {
            if (fs.existsSync(exportMetaPath)) {
              const meta = JSON.parse(fs.readFileSync(exportMetaPath, 'utf8'));
              if (meta && typeof meta === 'object' && !meta.profileId && meta.exportMode) {
                meta.profileId = meta.exportMode;
              }
              return meta;
            }
          } catch { /* silencieux : fallback default */ }
          return { profileId: 'default', exportMode: 'default', exportFields: null };
        })(),
      });
    }

    console.log(`[JobHistory] ${jobs.length} job(s) chargé(s) — ${jobs.reduce((s, j) => s + j.adsCount, 0)} annonce(s) au total.`);
    return jobs.sort((a, b) => b.id.localeCompare(a.id));
  }

  static getLatestJob() {
    const jobs = this.listAllJobs();
    const latest = jobs.length > 0 ? jobs[0] : null;
    console.log(`[JobHistory] Dernier job : ${latest ? latest.id + ' (' + latest.adsCount + ' annonces)' : '(aucun)'}.`);
    return latest;
  }

  /**
   * Renvoie l'historique d'évolution des annonces à travers les sessions.
   * Voir buildAdHistory() pour la structure. Trié par activité décroissante.
   */
  static getAdHistory() {
    const jobs = this.listAllJobs();
    return buildAdHistory(jobs);
  }

  static deleteJob(jobId) {
    // Validation anti path-traversal : un renderer compromis pourrait passer un
    // jobId contenant '..' ou des séparateurs pour supprimer un dossier arbitraire.
    // On n'autorise que les noms au format job-<timestamp> (alphanum + -).
    if (!jobId || typeof jobId !== 'string' || !/^job-[a-zA-Z0-9-]+$/.test(jobId) || jobId.includes('..')) {
      console.warn(`[JobHistory] ID de job invalide (rejeté) : ${jobId}`);
      return false;
    }
    const jobsDir = this.getJobsDir();
    const jobPath = path.join(jobsDir, jobId);

    // Double-check : le chemin résolu doit bien rester dans JOBS_DIR.
    const resolved = path.resolve(jobPath);
    const baseResolved = path.resolve(jobsDir);
    if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
      console.warn(`[JobHistory] Chemin hors JOBS_DIR rejeté : ${resolved}`);
      return false;
    }

    if (fs.existsSync(jobPath)) {
      fs.rmSync(jobPath, { recursive: true, force: true });
      console.log(`[JobHistory] Job supprimé : ${jobId} (${jobPath}).`);
      return true;
    }
    console.warn(`[JobHistory] Suppression impossible — job introuvable : ${jobId} (${jobPath}).`);
    return false;
  }
}

module.exports = { JobHistoryManager, buildAdHistory };