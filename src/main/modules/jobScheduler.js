'use strict';

const { Notification } = require('electron');

class JobSchedulerManager {
  constructor(onTriggerJob) {
    this.onTriggerJob = onTriggerJob; // Callback de lancement
    this.schedules = new Map(); // id -> timer
    this.scheduledTasks = [];
  }

  /**
   * Ajoute ou met à jour une tâche planifiée
   */
  addSchedule(task) {
    const { id, searchUrl, pages, intervalMinutes, enabled = true } = task;

    this.removeSchedule(id);

    if (!enabled) return;

    const intervalMs = parseInt(intervalMinutes, 10) * 60 * 1000;

    const timer = setInterval(() => {
      console.log(`⏰ [Scheduler] Lancement automatique de la tâche : ${id}`);
      this.onTriggerJob({
        searchUrl,
        pages,
        noDesc: false,
        csv: true,
        isScheduled: true,
      });
    }, intervalMs);

    this.schedules.set(id, timer);
    this.scheduledTasks.push({ ...task, nextRun: Date.now() + intervalMs });
  }

  /**
   * Supprime une tâche planifiée
   */
  removeSchedule(id) {
    if (this.schedules.has(id)) {
      clearInterval(this.schedules.get(id));
      this.schedules.delete(id);
    }
    this.scheduledTasks = this.scheduledTasks.filter((t) => t.id !== id);
  }

  /**
   * Liste toutes les tâches planifiées
   */
  listSchedules() {
    return this.scheduledTasks;
  }

  /**
   * Envoie une notification Windows si une Bonne Affaire est trouvée
   */
  static notifyGoodDeal(ad) {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: '🟢 NOUVELLE BONNE AFFAIRE LEBONCOIN !',
        body: `${ad.title || 'Annonce'} - ${ad.price ? ad.price + '€' : ''} (${ad.city || 'Inconnue'})\n${ad.dealDiscountPct ? ad.dealDiscountPct + '% sous le marché' : ''}`,
        silent: false,
      });

      notification.show();
    }
  }
}

module.exports = { JobSchedulerManager };