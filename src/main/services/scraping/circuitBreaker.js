'use strict';

/**
 * CircuitBreaker — machine à états explicite de l'enrichissement.
 *
 * Remplace les compteurs dispersés (`consecutiveBlocks`, `shouldStopAll`) par
 * une machine à états documentée :
 *
 *   normal  → slowed  → blocked → stopped
 *   \___________________________/
 *        (reset sur succès)
 *
 * Règles (seuils dans config/scraping.js) :
 *   - succès            → retour à `normal` (compteur de blocages remis à 0) ;
 *   - erreur réseau/HTTP→ `slowed` (on ralentit mais on continue) ;
 *   - blocage (403/429) → incrémente le compteur ; à `blockThreshold` blocages
 *                         CONSÉCUTIFS → `blocked` puis `stopped`.
 *
 * Le disjoncteur est PUR (aucune I/O) : facile à tester et à réutiliser.
 */

const { CIRCUIT_STATES, BLOCK_THRESHOLD } = require('../../config/scraping');

class CircuitBreaker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.blockThreshold] Blocages consécutifs avant arrêt
   * @param {string} [opts.logger] Préfixe de log (facultatif)
   */
  constructor(opts = {}) {
    this.blockThreshold = opts.blockThreshold || BLOCK_THRESHOLD;
    this.state = CIRCUIT_STATES.NORMAL;
    this.consecutiveBlocks = 0;
    this.totalBlocks = 0;
    this.totalErrors = 0;
    this.successes = 0;
    // Dernier code de blocage observé (HTTP_403 / HTTP_429) pour un rapport structuré.
    this.lastBlockCode = null;
    this.lastBlockStatus = null;
    // Arrêt dû à une ANNULATION utilisateur (et non à un blocage d'accès) : sans
    // ce drapeau, `stopInfo()` renvoyait « access_refused » sur une annulation
    // (state forcé à « stopped » par le handler SIGINT) et le rapport/exit code
    // faisait croire à un refus 403 du serveur.
    this.cancelled = false;
  }

  /** Signale un succès : remet le disjoncteur au repos. */
  recordSuccess() {
    this.successes++;
    this.consecutiveBlocks = 0;
    if (this.state !== CIRCUIT_STATES.STOPPED) this.state = CIRCUIT_STATES.NORMAL;
  }

  /** Signale une erreur non-blocante (réseau, HTTP 5xx/404…). */
  recordError() {
    this.totalErrors++;
    if (this.state === CIRCUIT_STATES.NORMAL) this.state = CIRCUIT_STATES.SLOWED;
  }

  /**
   * Signale un blocage d'accès (403/429).
   * @param {number} [status] Code HTTP (403/429)
   * @param {string} [code] Code d'erreur structuré (HTTP_403 / HTTP_429)
   * @returns {boolean} true si l'arrêt est désormais requis
   */
  recordBlock(status, code) {
    this.totalBlocks++;
    this.consecutiveBlocks++;
    if (status != null) this.lastBlockStatus = status;
    if (code != null) this.lastBlockCode = code;
    if (this.consecutiveBlocks >= this.blockThreshold) {
      this.state = CIRCUIT_STATES.STOPPED;
      return true;
    }
    this.state = CIRCUIT_STATES.BLOCKED;
    return false;
  }

  /** true si l'enrichissement doit s'arrêter. */
  shouldStop() {
    return this.state === CIRCUIT_STATES.STOPPED;
  }

  /**
   * Marque un arrêt volontaire (annulation utilisateur) : le disjoncteur passe
   * en « stopped » sans blocage d'accès, de sorte que `stopInfo()` renvoie null
   * (aucune 403/429 à rapporter, aucun exit code 3/4, aucune « fausse réussite
   * partielle » pour un accès bloqué).
   */
  markCancelled() {
    this.cancelled = true;
    this.state = CIRCUIT_STATES.STOPPED;
  }

  /**
   * Motif d'arrêt structuré (pour le rapport / les logs), ou null si pas arrêté.
   * Une annulation utilisateur ne produit AUCUN motif d'accès (null) : ce n'est
   * ni un 403 ni un 429.
   * @returns {{reason: string, status: number|null, code: string|null, consecutiveBlocks: number}|null}
   */
  stopInfo() {
    if (this.state !== CIRCUIT_STATES.STOPPED) return null;
    if (this.cancelled) return null;
    return {
      reason: this.lastBlockStatus === 429 || this.lastBlockCode === 'HTTP_429' ? 'rate_limited' : 'access_refused',
      status: this.lastBlockStatus,
      code: this.lastBlockCode,
      consecutiveBlocks: this.consecutiveBlocks,
    };
  }

  /** Instantané pour le rapport. */
  snapshot() {
    return {
      state: this.state,
      consecutiveBlocks: this.consecutiveBlocks,
      totalBlocks: this.totalBlocks,
      totalErrors: this.totalErrors,
      successes: this.successes,
      lastBlockStatus: this.lastBlockStatus,
      lastBlockCode: this.lastBlockCode,
    };
  }
}

module.exports = { CircuitBreaker };
