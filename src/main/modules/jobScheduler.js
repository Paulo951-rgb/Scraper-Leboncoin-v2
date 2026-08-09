'use strict';

const { Notification } = require('electron');

class JobSchedulerManager {
  constructor(onTriggerJob) {
    this.onTriggerJob = onTriggerJob; // Callback de lancement
    this.schedules = new Map(); // id -> timer
    this.scheduledTasks = new Map(); // id -> task (avec intervalMs, addedAt, lastRun)
  }

  /**
   * Ajoute ou met à jour une tâche planifiée.
   * Propage la config complète (aiConfig, proxyUrl, limit, etc.) au callback de déclenchement.
   */
  addSchedule(task) {
    const { id, searchUrl, pages, intervalMinutes, enabled = true } = task;

    this.removeSchedule(id);

    if (!enabled) return;

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
      addedAt: now,
      lastRun: null,
    };
    this.scheduledTasks.set(id, stored);

    const timer = setInterval(() => {
      console.log(`⏰ [Scheduler] Lancement automatique de la tâche : ${id}`);
      stored.lastRun = Date.now();
      this.onTriggerJob(this._triggerPayload(stored));
    }, intervalMs);

    this.schedules.set(id, timer);
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
  removeSchedule(id) {
    if (this.schedules.has(id)) {
      clearInterval(this.schedules.get(id));
      this.schedules.delete(id);
    }
    this.scheduledTasks.delete(id);
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

  /**
   * Envoie une notification Windows si une Bonne Affaire est trouvée.
   * Utilise le champ `marketAnalysis.diffPct` réellement produit par MarketAnalyzer.
   */
  static notifyGoodDeal(ad) {
    if (!Notification.isSupported()) return;

    const ma = ad.marketAnalysis || {};
    const diffPct = ma.diffPct;
    const discountText =
      diffPct != null
        ? `${diffPct > 0 ? '+' : ''}${diffPct}% vs marché`
        : '';

    const body = `${ad.title || 'Annonce'} - ${ad.price ? ad.price + '€' : ''} (${ad.city || 'Inconnue'})${discountText ? '\n' + discountText : ''}`;

    new Notification({
      title: '🟢 NOUVELLE BONNE AFFAIRE LEBONCOIN !',
      body,
      silent: false,
    }).show();
  }
}

module.exports = { JobSchedulerManager };