'use strict';

/**
 * OllamaProvider — implémentation concrète de AIProvider pour un serveur
 * Ollama local (http://127.0.0.1:11434).
 *
 * Capabilities : chatText (tous modèles) + chatVision (modèles vision type llava).
 * Réutilise le health-check existant (ollamaHealth.js) pour vérifier que le
 * serveur tourne et que le modèle demandé est chargé.
 *
 * Fetch natif Node.js : PAS d'option timeout → AbortController + setTimeout.
 */

const { AIProvider } = require('./aiProvider');
const { checkOllamaHealth, checkModelAvailable } = require('../ollamaHealth');

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_TEXT_MODEL = 'llama3';
const DEFAULT_VISION_MODEL = 'llava';
const DEFAULT_TIMEOUT_MS = 120000;

function _withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

class OllamaProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    this.ollamaUrl = (config.ollamaUrl || DEFAULT_URL).replace(/\/$/, '');
    this.defaultTextModel = config.textModel || DEFAULT_TEXT_MODEL;
    this.defaultVisionModel = config.visionModel || DEFAULT_VISION_MODEL;
    this.defaultTimeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  supportsVision() {
    return true;
  }

  async checkHealth() {
    const modelName = this.config.textModel || this.defaultTextModel;
    return await checkModelAvailable(this.ollamaUrl, modelName);
  }

  async chatText(prompt, opts = {}) {
    const model = opts.model || this.defaultTextModel;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    // Le signal couvre TOUT le cycle : en-têtes + lecture du corps. On ne
    // libère le timer qu'APRÈS res.json(), sinon Ollama peut accepter la
    // requête puis ne jamais finir d'écrire le corps (modèle bloqué en
    // chargement, génération infinie) → res.json() pendait indéfiniment,
    // bloquant un worker du pool de concurrence jusqu'à figer l'analyse.
    const to = _withTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          ...(opts.jsonFormat ? { format: 'json' } : {}),
          ...(opts.temperature != null ? { options: { temperature: opts.temperature } } : {}),
        }),
        signal: to.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}${detail ? ' : ' + detail.slice(0, 200) : ''}`);
      }
      const data = await res.json();
      const text = data && (data.response || data.message || '');
      if (!text) throw new Error('Réponse Ollama vide (pas de texte généré).');
      return text.trim();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`Ollama timeout (${timeoutMs}ms) — génération interrompue (modèle trop lent ou bloqué).`);
      }
      throw err;
    } finally {
      to.done();
    }
  }

  async chatVision(prompt, images, opts = {}) {
    const model = opts.model || this.defaultVisionModel;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    if (!Array.isArray(images) || images.length === 0) {
      // Pas d'images : on dégrade vers un appel texte.
      return await this.chatText(prompt, opts);
    }
    const imagesPayload = images.map((img) => img.data);

    // Même garde que chatText : le timeout doit couvrir la lecture du corps
    // (les modèles vision sont lents, le corps peut mettre plusieurs minutes).
    const to = _withTimeout(timeoutMs);
    try {
      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          images: imagesPayload,
          stream: false,
          options: { temperature: opts.temperature != null ? opts.temperature : 0.2, num_ctx: 4096 },
          ...(opts.jsonFormat ? { format: 'json' } : {}),
        }),
        signal: to.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Ollama Vision HTTP ${res.status}${detail ? ' : ' + detail.slice(0, 200) : ''}`);
      }
      const data = await res.json();
      const text = data && (data.response || data.message || '');
      if (!text) throw new Error('Réponse Ollama Vision vide.');
      return text.trim();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`Ollama Vision timeout (${timeoutMs}ms) — génération interrompue.`);
      }
      throw err;
    } finally {
      to.done();
    }
  }
}

module.exports = { OllamaProvider };
