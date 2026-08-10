'use strict';

/**
 * Registre des moteurs de recherche (SearchProvider).
 *
 * Permet de basculer facilement entre le moteur sans-clé par défaut
 * (DuckDuckGo) et un futur moteur à clé API (Tavily, Serper, Bing, Google…)
 * sans modifier l'IA Marché.
 *
 * Usage :
 *   const { getSearchProvider, registerSearchProvider } = require('./searchProviderRegistry');
 *   const engine = getSearchProvider({ provider: 'duckduckgo' });
 *   const { ok, results } = await engine.search('RTX 3060 occasion');
 *
 * Pour ajouter un moteur à clé plus tard :
 *   1. Implémenter SearchProvider (ex: tavilySearchProvider.js)
 *   2. registerSearchProvider('tavily', (cfg) => new TavilySearchProvider(cfg))
 *   3. getSearchProvider({ provider: 'tavily', apiKey: '...' })
 */

const { DuckDuckGoSearchProvider } = require('./duckDuckGoSearchProvider');

const registry = new Map();

function registerSearchProvider(name, factory) {
  if (typeof factory !== 'function') throw new Error(`Factory invalide pour le moteur "${name}".`);
  registry.set(name, factory);
}

/**
 * Construit un SearchProvider à partir d'une config.
 * @param {object} [config]
 * @param {string} [config.provider]  nom du moteur ('duckduckgo' par défaut)
 * @returns {import('./searchProvider').SearchProvider}
 */
function getSearchProvider(config = {}) {
  const name = (config.provider || 'duckduckgo').toLowerCase();
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Moteur de recherche inconnu : "${name}". Moteurs enregistrés : ${[...registry.keys()].join(', ') || '(aucun)'}`);
  }
  return factory(config);
}

function listSearchProviders() {
  return [...registry.keys()];
}

// Enregistrement du moteur par défaut (sans clé).
registerSearchProvider('duckduckgo', (cfg) => new DuckDuckGoSearchProvider(cfg));

module.exports = { getSearchProvider, registerSearchProvider, listSearchProviders };
