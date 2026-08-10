'use strict';

/**
 * Registre des fournisseurs d'IA (AIProvider).
 *
 * Permet de changer de moteur d'IA (Ollama local aujourd'hui, infrastructure
 * distante demain) sans toucher aux modules métier.
 *
 * Usage :
 *   const { getAIProvider } = require('./aiProviderRegistry');
 *   const ai = getAIProvider({ provider: 'ollama', textModel: 'llama3', visionModel: 'llava' });
 *   const text = await ai.chatText('...');
 *   const vision = await ai.chatVision('...', images);
 */

const { OllamaProvider } = require('./ollamaProvider');

const registry = new Map();

function registerAIProvider(name, factory) {
  if (typeof factory !== 'function') throw new Error(`Factory invalide pour le provider IA "${name}".`);
  registry.set(name, factory);
}

/**
 * Construit un AIProvider à partir d'une config.
 * @param {object} [config]
 * @param {string} [config.provider]  'ollama' par défaut
 * @returns {import('./aiProvider').AIProvider}
 */
function getAIProvider(config = {}) {
  const name = (config.provider || 'ollama').toLowerCase();
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Provider IA inconnu : "${name}". Providers enregistrés : ${[...registry.keys()].join(', ') || '(aucun)'}`);
  }
  return factory(config);
}

function listAIProviders() {
  return [...registry.keys()];
}

// Enregistrement du provider local par défaut.
registerAIProvider('ollama', (cfg) => new OllamaProvider(cfg));

module.exports = { getAIProvider, registerAIProvider, listAIProviders };
