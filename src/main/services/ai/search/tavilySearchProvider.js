'use strict';

/**
 * TavilySearchProvider — moteur de recherche À CLÉ API (fiable, conçu pour IA).
 *
 * DuckDuckGo (sans clé) est de plus en plus bloqué par son anti-bot (page
 * « anomaly » / captcha) qui renvoie 0 résultat aux requêtes automatisées,
 * surtout en concurrence. Tavily est un moteur d'indexation conçu pour les
 * agents IA : API REST JSON stable, pas d'anti-bot, quota gratuit suffisant
 * pour l'analyse de marché.
 *
 * La clé API est fournie via la config (searchConfig.apiKey) — le renderer
 * demande la clé dans l'UI et la passe au handler market:analyze, qui la
 * transmet à getSearchProvider. Aucune clé n'est codée en dur ici.
 *
 * Docs API : https://docs.tavily.com/documentation/api-reference/search
 */

const { SearchProvider } = require('./searchProvider');

const TAVILY_URL = 'https://api.tavily.com/search';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LIMIT = 10;

function _withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

class TavilySearchProvider extends SearchProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.TAVILY_API_KEY || '';
    this.defaultTimeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return 'Tavily (clé API)';
  }

  requiresApiKey() {
    return true;
  }

  async checkHealth() {
    if (!this.apiKey) {
      return { ok: false, message: 'Clé API Tavily manquante — renseignez-la dans les réglages IA Marché.' };
    }
    return { ok: true, message: 'Tavily prêt (clé configurée).' };
  }

  async search(query, opts = {}) {
    const limit = opts.limit || DEFAULT_LIMIT;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;

    if (!query || typeof query !== 'string') {
      return { ok: false, results: [], message: 'Requête vide.' };
    }
    if (!this.apiKey) {
      return { ok: false, results: [], message: 'Clé API Tavily manquante.' };
    }

    const to = _withTimeout(timeoutMs);
    let res;
    try {
      res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          query,
          max_results: limit,
          search_depth: 'basic',
          // On veut des sources exploitables pour l'estimation de valeur, pas
          // de réponse générée : on récupère uniquement les résultats bruts.
          include_answer: false,
        }),
        signal: to.signal,
      });
    } catch (err) {
      to.done();
      const reason = err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message;
      return { ok: false, results: [], message: `Tavily injoignable : ${reason}` };
    }

    if (!res.ok) {
      to.done();
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, results: [], message: `Tavily clé invalide/non autorisée (HTTP ${res.status}).` };
      }
      if (res.status === 429) {
        return { ok: false, results: [], message: 'Tavily quota dépassé (HTTP 429) — attendez ou changez de plan.' };
      }
      return { ok: false, results: [], message: `Tavily HTTP ${res.status}${detail ? ' : ' + detail : ''}` };
    }

    try {
      const data = await res.json();
      const rawResults = Array.isArray(data.results) ? data.results : [];
      if (rawResults.length === 0) {
        return { ok: false, results: [], message: 'Tavily : 0 résultat pour cette requête.' };
      }
      const results = rawResults.map((r) => ({
        title: r.title || '(sans titre)',
        snippet: r.content || '',
        url: r.url || '',
        source: _hostFromUrl(r.url),
      }));
      return { ok: true, results };
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message;
      return { ok: false, results: [], message: `Tavily réponse illisible : ${reason}` };
    } finally {
      to.done();
    }
  }
}

function _hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

module.exports = { TavilySearchProvider };
