'use strict';

/**
 * Notifications système (Electron Notification).
 * La notification est déclenchée par le handler job:start lorsqu'une
 * "Très bonne affaire" est détectée à la fin d'un scraping.
 */
const { Notification } = require('electron');

class Notifier {
  /**
   * Envoie une notification Windows/native si une Bonne Affaire est trouvée.
   * Utilise le champ `marketAnalysis.diffPct` produit par MarketAnalyzer.
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

  static isSupported() {
    return Notification.isSupported();
  }
}

module.exports = { Notifier };
