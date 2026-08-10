'use strict';

/**
 * Interface abstraite pour les moteurs de recherche utilisés par l'IA Marché.
 *
 * L'IA Marché a besoin de rechercher le modèle exact d'un produit sur Internet
 * pour estimer sa valeur réelle. Un SearchProvider ramène des résultats bruts
 * (titre + extrait + URL) ; c'est ensuite l'IA locale qui synthétise ces
 * résultats en une estimation de valeur.
 *
 * Architecture enfichable : le moteur sans-clé (DuckDuckGo/Searx) est utilisé
 * par défaut aujourd'hui ; un moteur à clé API (Tavily, Serper, Bing, Google)
 * pourra être ajouté plus tard en implémentant simplement cette interface.
 *
 * Contrat de fiabilité : si le moteur échoue (réseau, HTML modifié, rate-limit),
 * search() doit RENVOYER UN OBJET ok:false — JAMAIS inventer de résultats.
 * L'IA Marché distingue ainsi les sources réellement trouvées des informations
 * déduites par l'IA.
 */

/**
 * @typedef {Object} SearchResult
 * @property {string} title    titre du résultat
 * @property {string} snippet  extrait / description
 * @property {string} url      URL source
 * @property {string} [source] nom du site source (ex: "leboncoin", "amazon")
 */

class SearchProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /** Nom lisible du moteur (ex: "DuckDuckGo"). */
  get name() {
    return 'SearchProvider';
  }

  /**
   * Indique si ce moteur nécessite une clé API configurée.
   * @returns {boolean}
   */
  requiresApiKey() {
    return false;
  }

  /**
   * Vérifie que le moteur est prêt à fonctionner (clé présente si nécessaire).
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async checkHealth() {
    return { ok: !this.requiresApiKey(), message: this.requiresApiKey() ? 'Clé API manquante.' : 'Prêt.' };
  }

  /**
   * Effectue une recherche web et renvoie des résultats bruts.
   *
   * @param {string} query        requête de recherche (modèle produit, etc.)
   * @param {object} [opts]
   * @param {number} [opts.limit]      nombre de résultats souhaité (défaut 10)
   * @param {number} [opts.timeoutMs]  timeout (défaut du provider sinon)
   * @returns {Promise<{ ok: boolean, results: SearchResult[], message?: string }>}
   *          ok=false si le moteur a échoué (results vide). NE JAMAIS inventer.
   */
  async search(query, opts = {}) {
    throw new Error('search() non implémenté par ce provider.');
  }
}

module.exports = { SearchProvider };
