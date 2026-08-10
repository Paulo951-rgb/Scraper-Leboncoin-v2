'use strict';

/**
 * DuckDuckGoSearchProvider — moteur de recherche SANS CLÉ API.
 *
 * Implémentation par défaut de SearchProvider. Utilise DuckDuckGo Lite
 * (https://lite.duckduckgo.com/lite/) qui renvoie du HTML simple et stable,
 * facile à parser. Aucune clé, aucune inscription.
 *
 * Fiabilité : si le HTML change ou que DDG rate-limit, search() renvoie
 * { ok:false } — on n'invente JAMAIS de résultats. L'IA Marché le sait et
 * adapte son message (« sources introuvables » vs « sources trouvées »).
 *
 * Ce moteur est le default. Pour ajouter un moteur à clé plus tard
 * (Tavily, Serper, Bing, Google), il suffit d'implémenter SearchProvider.
 */

const { SearchProvider } = require('./searchProvider');

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_LIMIT = 10;

function _withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Extrait les résultats du HTML de DuckDuckGo Lite.
 * DDG Lite présente les résultats dans une table : chaque lien a un .result-link.
 * On extrait href + titre + snippet associé de façon robuste.
 */
function parseDdgLite(html) {
  const results = [];
  // Liens de résultats
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets dans les cellules suivantes (.result-snippet)
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  let m;
  const links = [];
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ href: decodeHtmlEntities(m[1]), title: stripTags(m[2]).trim() });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < links.length; i++) {
    if (!links[i].href) continue;
    results.push({
      title: links[i].title || '(sans titre)',
      snippet: snippets[i] || '',
      url: links[i].href,
      source: hostFromUrl(links[i].href),
    });
  }
  return results;
}

/**
 * Détecte la page anti-bot (anomaly / captcha) que DuckDuckGo renvoie aux
 * requêtes automatisées. DDG ne renvoie pas 403 dans ce cas : il répond
 * HTTP 202 avec une page « anomaly-modal » et AUCUN résultat. Sans cette
 * détection, l'erreur est trompeusement étiquetée « structure modifiée »
 * alors que la vraie cause est un blocage anti-bot.
 */
function isAnomalyPage(html, status) {
  if (status === 202) return true; // DDG sert 202 + anomaly aux bots
  if (!html) return false;
  const low = html.toLowerCase();
  return low.includes('anomaly-modal') || low.includes('anomaly-modal__')
    || (low.includes('captcha') && low.includes('puzzle'));
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'");
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

class DuckDuckGoSearchProvider extends SearchProvider {
  constructor(config = {}) {
    super(config);
    this.defaultTimeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return 'DuckDuckGo (sans clé)';
  }

  requiresApiKey() {
    return false;
  }

  async checkHealth() {
    // On ne ping pas à chaque fois (DDG peut bloquer un ping HEAD).
    // On déclare prêt : l'échec éventuel se manifestera au search().
    return { ok: true, message: 'DuckDuckGo prêt (sans clé API).' };
  }

  async search(query, opts = {}) {
    const limit = opts.limit || DEFAULT_LIMIT;
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;

    if (!query || typeof query !== 'string') {
      return { ok: false, results: [], message: 'Requête vide.' };
    }

    // Retry avec backoff exponentiel : DDG rate-limite/anti-bot agressivement
    // en concurrence. Un 403 ou un « fetch failed » transitoire peut réussir
    // au 2e essai après une courte pause. On ne retire PAS sur une page
    // anomaly (blocage anti-bot persistant — retirer ne ferait que délayer).
    const MAX_ATTEMPTS = 3;
    let lastResult = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await this._searchOnce(query, { limit, timeoutMs });

      // Succès ou blocage définitif (anomaly / clé / structure) : on retourne.
      if (r.ok) return r;
      if (r.blocked) return { ok: false, results: [], message: r.message };

      // Échec transitoire (403 / fetch failed / timeout) : retry avec backoff.
      lastResult = r;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 800 * Math.pow(2, attempt - 1); // 800ms, 1600ms
        await _sleep(backoff);
      }
    }
    return { ok: false, results: [], message: lastResult ? lastResult.message : 'DuckDuckGo indisponible.' };
  }

  async _searchOnce(query, { limit, timeoutMs }) {
    const body = new URLSearchParams();
    body.set('q', query);
    body.set('kl', 'fr-fr');

    // Le signal couvre en-têtes + lecture du corps : sans cela, une réponse
    // DDG qui envoie les en-têtes puis bloque le corps pendait res.text()
    // indéfiniment (le timer était libéré trop tôt).
    const to = _withTimeout(timeoutMs);
    let res;
    try {
      res = await fetch(DDG_LITE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          // DuckDuckGo bloque les requêtes sans User-Agent identifiable.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        body: body.toString(),
        signal: to.signal,
      });
    } catch (err) {
      to.done();
      const reason = err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message;
      // Échec transitoire (réseau) — retryable.
      return { ok: false, blocked: false, message: `DuckDuckGo injoignable : ${reason}` };
    }

    if (!res.ok) {
      to.done();
      // 403 = rate-limiting transitoire → retryable. 429 idem.
      // Autres (4xx/5xx) → on ne retire pas (probablement persistant).
      const retryable = res.status === 403 || res.status === 429;
      return {
        ok: false,
        blocked: !retryable,
        message: `DuckDuckGo HTTP ${res.status}${retryable ? ' (rate-limité, retry…)' : ''}`,
      };
    }

    try {
      const html = await res.text();
      // Détection anti-bot : DDG répond 200/202 avec une page « anomaly » et
      // AUCUN résultat. C'est un blocage persistant (IP marquée) — on ne retire
      // pas, on renvoie un message clair orientant vers un moteur à clé.
      if (isAnomalyPage(html, res.status)) {
        return {
          ok: false,
          blocked: true,
          message: 'DuckDuckGo a renvoyé une page anti-bot (captcha) — IP temporairement bloquée. Réduisez la concurrence IA Marché ou utilisez un moteur à clé API (Tavily) dans les réglages.',
        };
      }
      const all = parseDdgLite(html);
      if (all.length === 0) {
        // HTML non reconnu (structure changée) ou véritablement 0 résultat.
        return { ok: false, blocked: true, message: 'Aucun résultat parsé (structure DuckDuckGo modifiée ou 0 résultat).' };
      }
      return { ok: true, results: all.slice(0, limit) };
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timeout (${timeoutMs}ms)` : err.message;
      return { ok: false, blocked: false, message: `Lecture réponse impossible : ${reason}` };
    } finally {
      to.done();
    }
  }
}

module.exports = { DuckDuckGoSearchProvider, isAnomalyPage, parseDdgLite };
