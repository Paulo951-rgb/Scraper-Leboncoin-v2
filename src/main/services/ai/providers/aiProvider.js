'use strict';

/**
 * Interface abstraite pour les fournisseurs d'IA.
 *
 * Un AIProvider encapsule la manière de parler à un moteur d'IA (local Ollama
 * aujourd'hui, infrastructure distante demain). Les modules métier (analyse
 * d'annonce, analyse de marché, génération de prompt) dépendent uniquement de
 * cette interface — jamais d'une implémentation concrète. On peut donc changer
 * de moteur sans toucher à la logique métier.
 *
 * Deux capacités distinctes :
 *   - chatText()   : génère du texte libre (prompt IA, synthèse marché)
 *   - chatVision() : génère du texte en analysant texte + images (analyse annonce)
 *
 * Toutes les méthodes sont async et acceptent des options (timeout, modèle).
 * Elles renvoient toujours une string (texte brut de l'IA). Le parsing JSON
 * est la responsabilité de l'appelant.
 */

class AIProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /** Indique si ce provider gère la vision (texte + images). */
  supportsVision() {
    return false;
  }

  /**
   * Vérifie que le provider est joignable et le modèle chargé.
   * @returns {Promise<{ ok: boolean, message: string, models?: string[] }>}
   */
  async checkHealth() {
    throw new Error('checkHealth() non implémenté par ce provider.');
  }

  /**
   * Génère du texte à partir d'un prompt.
   * @param {string} prompt
   * @param {object} [opts] { model, timeoutMs, jsonFormat, temperature }
   * @returns {Promise<string>} texte généré
   */
  async chatText(prompt, opts = {}) {
    throw new Error('chatText() non implémenté par ce provider.');
  }

  /**
   * Génère du texte en analysant du texte + des images (base64).
   * @param {string} prompt
   * @param {Array<{data: string, mimeType: string}>} images  images en base64
   * @param {object} [opts]  voir chatText
   * @returns {Promise<string>} texte généré
   */
  async chatVision(prompt, images, opts = {}) {
    throw new Error('chatVision() non implémenté par ce provider (ou vision non supportée).');
  }
}

module.exports = { AIProvider };
