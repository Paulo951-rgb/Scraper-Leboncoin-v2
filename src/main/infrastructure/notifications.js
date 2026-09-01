'use strict';

/**
 * Notifications système (Electron Notification).
 * Déclenchée par le handler market:analyze (IA Marché) lorsqu'une
 * « Très bonne affaire » est détectée (verdict basé sur la valeur réelle en €).
 */
const { Notification } = require('electron');

class Notifier {
  /**
   * Envoie une notification native si une bonne affaire est trouvée.
   * Utilise les champs `marketAnalysis.deltaEur` et `verdictLabel` produits
   * par l'IA Marché (MarketValueAnalyzer).
   */
  static notifyGoodDeal(ad) {
    if (!Notification.isSupported()) return;

    const ma = ad.marketAnalysis || {};
    const delta = ma.deltaEur;
    const deltaText = delta != null ? `${delta > 0 ? '+' : ''}${delta} € vs marché` : '';
    const verdict = ma.verdictLabel || 'Bonne affaire';

    const prix = ad.prix ?? ad.price;
    const body = `${ad.title || 'Annonce'} - ${prix != null ? prix + ' €' : ''} (${ad.city || 'Inconnue'})${deltaText ? '\n' + deltaText : ''}`;

    new Notification({
      title: `🟢 ${verdict.toUpperCase()} LEBONCOIN !`,
      body,
      silent: false,
    }).show();
  }

  static isSupported() {
    return Notification.isSupported();
  }
}

module.exports = { Notifier };
