'use strict';

/**
 * Health-check Ollama.
 *
 * Vérifie que le serveur Ollama est démarré ET que le modèle demandé est
 * chargé, AVANT de lancer une analyse IA. Évite les échecs silencieux et
 * permet d'afficher un message clair à l'utilisateur.
 *
 * Usage :
 *   const { checkOllamaHealth } = require('./ollamaHealth');
 *   const { ok, message, models } = await checkOllamaHealth('http://127.0.0.1:11434', 'llama3');
 */

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Ping le serveur Ollama et liste les modèles disponibles.
 * @param {string} ollamaUrl   URL de base (ex: http://127.0.0.1:11434)
 * @param {number} [timeoutMs] Timeout fetch (défaut 5s)
 * @returns {Promise<{ ok: boolean, message: string, models: string[] }>}
 */
async function checkOllamaHealth(ollamaUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const base = (ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const tagsUrl = `${base}/api/tags`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(tagsUrl, { signal: controller.signal });

    if (!res.ok) {
      clearTimeout(timer);
      return {
        ok: false,
        message: `Ollama a répondu HTTP ${res.status} — le serveur est peut-être en cours de démarrage.`,
        models: [],
      };
    }

    // Lecture du corps sous le même timeout (un /api/tags qui bloque le corps
    // ne doit pas pendre indéfiniment).
    let data;
    try {
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name || m.model).filter(Boolean) : [];

    if (models.length === 0) {
      return {
        ok: false,
        message: 'Ollama est démarré mais aucun modèle n\'est installé. Lancez `ollama pull llama3`.',
        models: [],
      };
    }

    return {
      ok: true,
      message: `Ollama OK — ${models.length} modèle(s) disponible(s) : ${models.slice(0, 5).join(', ')}${models.length > 5 ? '…' : ''}.`,
      models,
    };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timeout (${timeoutMs}ms) — Ollama ne répond pas.`
      : err.message;
    return {
      ok: false,
      message: `Ollama injoignable sur ${base} : ${reason}. Vérifiez qu'Ollama est démarré (ollama serve).`,
      models: [],
    };
  }
}

/**
 * Vérifie qu'un modèle spécifique est disponible.
 * @param {string} ollamaUrl
 * @param {string} modelName  Nom du modèle (ex: llama3)
 * @returns {Promise<{ ok: boolean, message: string, available: boolean, models: string[] }>}
 */
async function checkModelAvailable(ollamaUrl, modelName) {
  const health = await checkOllamaHealth(ollamaUrl);
  if (!health.ok) {
    return { ...health, available: false };
  }

  // Ollama peut suffixer les noms de modèles (ex: llama3:latest).
  const available = health.models.some((m) => m === modelName || m.startsWith(`${modelName}:`));
  if (!available) {
    return {
      ok: false,
      message: `Modèle "${modelName}" non trouvé. Modèles disponibles : ${health.models.join(', ') || '(aucun)'}. Lancez \`ollama pull ${modelName}\`.`,
      models: health.models,
      available: false,
    };
  }

  return { ...health, available: true };
}

module.exports = { checkOllamaHealth, checkModelAvailable };
