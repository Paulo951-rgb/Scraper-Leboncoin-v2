'use strict';

/**
 * JobSchedulerManager — ordonnanceur de tâches planifiées (cron-like).
 * Les tâches sont persistées sur disque (config/scheduled-tasks.json) et
 * restaurées au redémarrage de l'application.
 */
const path = require('path');
const fs = require('fs');

const SCHEDULES_PATH = path.join(__dirname, '..', '..', 'config', 'scheduled-tasks.json');

class JobSchedulerManager {
  constructor(onTriggerJob) {
    this.onTriggerJob = onTriggerJob; // Callback de lancement
    this.schedules = new Map(); // id -> timer
    this.scheduledTasks = new Map(); // id -> task (avec intervalMs, addedAt, lastRun)
    this._restoreFromDisk();
  }

  /**
   * Restaure les tâches sauvegardées sur disque au démarrage.
   */
  _restoreFromDisk() {
    try {
      if (!fs.existsSync(SCHEDULES_PATH)) return;
      const tasks = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
      if (!Array.isArray(tasks)) return;
      console.log(`[Scheduler] Restauration de ${tasks.length} tâche(s) depuis le disque.`);
      for (const task of tasks) {
        // On préserve lastRun pour que nextRun soit calculé correctement
        this.addSchedule(task, { skipSave: true });
      }
    } catch (err) {
      console.warn(`[Scheduler] Restauration impossible : ${err.message}`);
    }
  }

  /**
   * Sauvegarde toutes les tâches sur disque.
   */
  _saveToDisk() {
    try {
      fs.mkdirSync(path.dirname(SCHEDULES_PATH), { recursive: true });
      const tasks = [];
      for (const [id, task] of this.scheduledTasks.entries()) {
        tasks.push({
          id,
          searchUrl: task.searchUrl,
          pages: task.pages,
          intervalMinutes: task.intervalMinutes,
          enabled: task.enabled !== false,
          addedAt: task.addedAt,
          lastRun: task.lastRun,
          limit: task.limit,
          proxyUrl: task.proxyUrl,
          noDesc: task.noDesc,
          csv: task.csv,
          autoAiMarket: task.autoAiMarket,
          aiConfig: task.aiConfig,
        });
      }
      fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(tasks, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[Scheduler] Sauvegarde impossible : ${err.message}`);
    }
  }

  /**
   * Ajoute ou met à jour une tâche planifiée.
   * Propage la config complète (aiConfig, proxyUrl, limit, etc.) au callback de déclenchement.
   */
  addSchedule(task, opts = {}) {
    const { id, searchUrl, pages, intervalMinutes, enabled = true } = task;

    this.removeSchedule(id, { skipSave: true });

    if (!enabled) {
      console.log(`[Scheduler] Tâche ${id} désactivée (enabled=false) — non planifiée.`);
      // Sauvegarde quand même pour que la tâche désactivée soit restaurée
      const stored = { ...task, intervalMs: parseInt(intervalMinutes, 10) * 60 * 1000, addedAt: Date.now(), lastRun: null };
      this.scheduledTasks.set(id, stored);
      if (!opts.skipSave) this._saveToDisk();
      return;
    }

    const intervalMs = parseInt(intervalMinutes, 10) * 60 * 1000;
    if (!(intervalMs > 0)) {
      console.warn(`[Scheduler] Intervalle invalide pour la tâche ${id} (${intervalMinutes} min) — tâche ignorée.`);
      return;
    }
    const now = Date.now();

    const stored = {
      ...task,
      searchUrl,
      pages,
      intervalMs,
      addedAt: task.addedAt || now,
      lastRun: task.lastRun || null,
    };
    this.scheduledTasks.set(id, stored);

    const timer = setInterval(() => {
      console.log(`⏰ [Scheduler] Lancement automatique de la tâche : ${id} (URL : ${searchUrl})`);
      stored.lastRun = Date.now();
      if (!opts.skipSave) this._saveToDisk();
      this.onTriggerJob(this._triggerPayload(stored));
    }, intervalMs);

    this.schedules.set(id, timer);
    console.log(`[Scheduler] Tâche ${id} planifiée — intervalle ${intervalMinutes} min (${intervalMs}ms) | URL : ${searchUrl} | pages : ${pages} | limit : ${task.limit ?? '(aucun)'} | proxy : ${task.proxyUrl || 'aucun'}.`);
    if (!opts.skipSave) this._saveToDisk();
  }

  /**
   * Construit la config complète transmise au callback de déclenchement.
   * Centralise la propagation de la config (aiConfig, proxyUrl, limit, etc.).
   */
  _triggerPayload(task) {
    return {
      searchUrl: task.searchUrl,
      pages: task.pages,
      noDesc: task.noDesc !== undefined ? task.noDesc : false,
      csv: task.csv !== undefined ? task.csv : true,
      autoAiMarket: task.autoAiMarket !== undefined ? task.autoAiMarket : true,
      limit: task.limit,
      aiConfig: task.aiConfig,
      proxyUrl: task.proxyUrl,
      isScheduled: true,
    };
  }

  /**
   * Supprime une tâche planifiée
   */
  removeSchedule(id, opts = {}) {
    if (this.schedules.has(id)) {
      clearInterval(this.schedules.get(id));
      this.schedules.delete(id);
    }
    this.scheduledTasks.delete(id);
    if (!opts.skipSave) this._saveToDisk();
  }

  /**
   * Liste toutes les tâches planifiées avec un `nextRun` calculé dynamiquement.
   */
  listSchedules() {
    const now = Date.now();
    const result = [];

    for (const [id, task] of this.scheduledTasks.entries()) {
      const reference = task.lastRun || task.addedAt || now;
      const elapsed = now - reference;
      const cyclesSince = Math.floor(elapsed / task.intervalMs);
      const nextRun = reference + (cyclesSince + 1) * task.intervalMs;

      result.push({
        id,
        searchUrl: task.searchUrl,
        pages: task.pages,
        intervalMinutes: task.intervalMinutes,
        intervalMs: task.intervalMs,
        enabled: task.enabled !== false,
        addedAt: task.addedAt,
        lastRun: task.lastRun,
        nextRun,
      });
    }

    return result;
  }
}

module.exports = { JobSchedulerManager };