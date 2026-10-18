'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { sleep } = require('../../utils/helpers');
const { GLOBAL_SESSION_PATH } = require('../../config/constants');
const { RESTRICTED_SESSION_FLAG_PATH } = require('../../config/constants');
const { formatBytes, formatMs, describeError } = require('../../utils/diagnostics');

const { getRandomUserAgent } = require('./userAgents');
const { ErrorCodes, createError } = require('./errorCodes');
const { NetworkJournal } = require('./networkJournal');
const { readProgress, writeProgress, mergeHarFiles } = require('./captureState');
const { SCRAPING_POLICY } = require('../../config/scraping');
const { isSafeFetchDestination } = require('../../utils/urlSecurity');
const {
  createStealthProfile,
  applyStealthToContext,
  clientHeadersFor,
  detectCloudFrontBlock,
  detectRestrictionPage,
  looksLikeResultsPage,
  countAdCards,
  ACCESS_BLOCK_MARKERS,
  launchOptionsFor,
} = require('./stealthProfile');

// Domaines autorisés comme source de scraping. L'URL de recherche saisie par
// l'utilisateur doit pointer vers l'un de ces domaines (ou un sous-domaine) :
// toute autre destination est refusée AVANT le lancement de Chromium (anti-SSRF).
// Les sous-requêtes sont en outre filtrées par `_installNetworkGuard`.
const LEBONCOIN_SOURCE_HOSTS = ['leboncoin.fr', 'leboncoin.com', 'leboncoindirect.com'];

function buildPageUrl(baseUrl, pageNumber) {
  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set('page', String(pageNumber));
    return urlObj.toString();
  } catch (err) {
    throw new Error(`URL invalide : "${baseUrl}" (${err.message})`);
  }
}

/**
 * Masque les paramètres sensibles d'une URL pour la journalisation. On garde
 * origine + chemin (utile au diagnostic) mais on remplace la valeur des
 * paramètres de requête par `<masqué>` : une URL de recherche peut contenir des
 * termes personnels, jamais des secrets de session (ceux-ci vivent dans les
 * cookies, qu'on ne journalise JAMAIS).
 * @param {string} rawUrl
 * @returns {string}
 */
function sanitizeUrlForLog(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const keys = Array.from(u.searchParams.keys());
    for (const k of keys) u.searchParams.set(k, '<masqué>');
    return u.toString();
  } catch {
    return '(URL illisible)';
  }
}

class HarCapturer extends EventEmitter {
  constructor(options = {}) {
    super();
    // Par défaut invisible. La bascule visible/invisible est gérée en interne
    // lors du pré-check captcha (voir _warmupSession).
    this.headless = options.headless !== undefined ? options.headless : true;
    this.proxyUrl = options.proxyUrl || null;
    // Délai entre pages de recherche : politique fixe (400 ms nominal).
    // Le délai est un délai NOMINAL, pas une autorisation de contourner une
    // limitation explicite du site (cf. gestion 403/429 pendant la capture).
    this.minPageDelayMs = options.minPageDelayMs ?? SCRAPING_POLICY.pageDelayMs;
    this.maxPageDelayMs = options.maxPageDelayMs ?? SCRAPING_POLICY.pageDelayMs;
    this.isCancelled = false;
    // Journal réseau structuré (compteurs objectifs pour report.json) : compte
    // les navigations, pages réussies/échouées et blocages avec leur URL.
    this.journal = options.journal || new NetworkJournal();
    // 🛑 FIX CRITIQUE : UA FIXE pour toute la durée de la capture.
    // Avant, chaque _newStealthContext() appelait getRandomUserAgent() → UA
    // différent entre le warmup et la capture. Leboncoin détectait l'incohérence
    // (mêmes cookies + UA différent) → HTTP 403 au 1er scraping.
    // Un UA unique, choisi une fois, garantit la cohérence de l'empreinte.
    this._userAgent = getRandomUserAgent();
    // Empreinte client cohérente (UA ↔ Sec-CH-UA ↔ JS anti-détection) appliquée à
    // CHAQUE contexte. C'est le cœur du contournement CloudFront/anti-bot : un
    // client crédible plutôt qu'un client « annoncé Chrome mais qui se comporte
    // comme un robot » (cf. stealthProfile.js).
    this._profile = createStealthProfile(this._userAgent);
  }

  stop() {
    this.isCancelled = true;
  }

  // UA figé pour toute la capture. Exposé pour que le pipeline d'enrichissement
  // réutilise EXACTEMENT le même UA (cohérence d'empreinte cookies+UA → 403 évité).
  getUserAgent() {
    return this._userAgent;
  }

  _launchOptions(headless) {
    // Options durcies partagées (cf. stealthProfile.launchOptionsFor) :
    //  - `channel: 'chromium'` force le build Chromium complet embarqué
    //    (chrome-<platform>) au lieu du « headless shell » séparé (non embarqué
    //    par electron-builder → « Executable doesn't exist » sinon) ;
    //  - `ignoreDefaultArgs: ['--enable-automation']` retire le commutateur qui
    //    force `navigator.webdriver` côté moteur ;
    //  - args anti-détection (AutomationControlled désactivé, etc.).
    return launchOptionsFor(headless, this.proxyUrl);
  }

  _baseContextOptions(extras = {}) {
    return {
      userAgent: this._userAgent,
      locale: this._profile.locale,
      timezoneId: this._profile.timezoneId,
      viewport: { ...this._profile.viewport },
      ...extras,
    };
  }

  async _newStealthContext(browser, contextOptions) {
    const ctx = await browser.newContext(contextOptions);
    // Défense en profondeur (anti-SSRF) : filtre CHAQUE sous-requête du contexte.
    // Une navigation/redirection/sous-ressource vers une destination
    // structurellement dangereuse (IP privée, schéma exotique) est bloquée.
    await this._installNetworkGuard(ctx);
    // Empreinte client cohérente : en-têtes Sec-CH-UA / Accept-Language +
    // script d'init anti-détection (webdriver, plugins, chrome, WebGL, UA-CH).
    // Appliquée à CHAQUE contexte (capture, warmup, reprise) → pas d'incohérence
    // détectable entre deux contextes successifs.
    await applyStealthToContext(ctx, this._profile);
    const p = await ctx.newPage();
    return { ctx, p };
  }

  /**
   * Installe un filtre réseau sur toutes les requêtes du contexte. Bloque les
   * destinations dangereuses identifiables sans DNS (IP privées, protocoles
   * exotiques, hostnames locaux). N'impose PAS l'allowlist Leboncoin ici : les
   * sous-ressources légitimes (CDN images, APIs) peuvent utiliser d'autres
   * domaines ; l'allowlist stricte ne s'applique qu'à l'URL de recherche saisie.
   * @param {import('playwright').BrowserContext} ctx
   */
  async _installNetworkGuard(ctx) {
    // Schémas internes au navigateur (données, blob, about, devtools) : ils ne
    // génèrent aucune connexion réseau et ne doivent pas être bloqués.
    const INTERNAL_SCHEMES = ['data:', 'blob:', 'about:', 'devtools:', 'chrome:', 'chrome-extension:'];
    await ctx.route('**/*', (route) => {
      const reqUrl = route.request().url();
      if (INTERNAL_SCHEMES.some((s) => reqUrl.startsWith(s))) return route.continue();
      // WebSocket : ramené à http(s) pour réutiliser le même contrôle de
      // destination (ws:// vers une IP privée doit être bloqué lui aussi).
      let checkUrl = reqUrl;
      if (reqUrl.startsWith('ws://')) checkUrl = 'http://' + reqUrl.slice(5);
      else if (reqUrl.startsWith('wss://')) checkUrl = 'https://' + reqUrl.slice(6);
      const check = isSafeFetchDestination(checkUrl);
      if (check.safe) return route.continue();
      this.journal.recordBlock(reqUrl, null);
      this.emit('log', { level: 'warn', message: `[security] Sous-requête bloquée (${check.reason}) : ${reqUrl.slice(0, 120)}` });
      return route.abort();
    });
  }
  /**
   * Diagnostic d'accès structuré et SANS SECRET. Journalise uniquement ce qui
   * permet de comprendre une décision d'accès : URL masquée, statut HTTP,
   * classification, présence/absence de marqueurs, décision de persistance et
   * raison d'arrêt. Ne journalise JAMAIS les cookies/jetons/session.
   * @param {object} info
   */
  _logAccessDiag(info) {
    const safe = {
      where: info.where || 'warmup',
      url: info.url ? sanitizeUrlForLog(info.url) : null,
      status: info.status ?? null,
      outcome: info.outcome ?? null,
      // Origine de l'observation décisive : 'browser' (DOM Chromium) ou 'probe'
      // (client HTTP isolé). Distingue les deux parcours (correction F1).
      source: info.source || null,
      restricted: !!info.restricted,
      restrictedMarker: info.restrictedMarker || null,
      cloudfront: !!info.cloudfront,
      captcha: !!info.captcha,
      resultsMarkers: !!info.hasResults,
      adCards: typeof info.adCards === 'number' ? info.adCards : null,
      // Un blocage d'ACCÈS a-t-il été observé (403/429/5xx, page restreinte,
      // CloudFront, CAPTCHA) ? Champ STRUCTURÉ utilisé pour compter honnêtement
      // les « Blocages d'accès » dans le résumé (un 403/CAPTCHA ne doit jamais
      // afficher 0). Distinct de `decision` (arrêt vs reprise). Par défaut, toute
      // décision d'ARRÊT (`decision === 'stop'`) est un blocage ; un appelant peut
      // forcer `blocked` explicitement.
      blocked: info.blocked !== undefined ? !!info.blocked : (info.decision === 'stop'),
      decision: info.decision || null,
      persist: info.persist === true,
      stopReason: info.stopReason || null,
    };
    this.emit('log', { level: 'info', message: `[ACCESS_DIAG] ${JSON.stringify(safe)}` });
  }

  /**
   * Marque la session globale comme RESTREINTE : tant que ce fichier existe, la
   * session n'est PAS réutilisée (elle porterait des cookies anti-bot qui
   * re-déclencheraient la restriction). Fichier simple, sans secret.
   */
  _markSessionRestricted(reason) {
    try {
      fs.mkdirSync(path.dirname(RESTRICTED_SESSION_FLAG_PATH), { recursive: true });
      fs.writeFileSync(RESTRICTED_SESSION_FLAG_PATH, JSON.stringify({ at: new Date().toISOString(), reason: reason || 'access_restricted' }));
      this.emit('log', { level: 'warn', message: `[warmup] Session marquée RESTREINTE (${RESTRICTED_SESSION_FLAG_PATH}) — elle ne sera pas réutilisée tant qu'un accès normal n'est pas confirmé.` });
    } catch (e) {
      this.emit('log', { level: 'warn', message: `[warmup] Impossible d'écrire le marqueur de session restreinte : ${e.message}` });
    }
  }

  /** Retire le marqueur de session restreinte (accès normal confirmé). */
  _clearSessionRestricted() {
    try {
      if (fs.existsSync(RESTRICTED_SESSION_FLAG_PATH)) {
        fs.unlinkSync(RESTRICTED_SESSION_FLAG_PATH);
        this.emit('log', { level: 'info', message: '[warmup] Accès normal confirmé — marqueur de session restreinte retiré.' });
      }
    } catch (e) {
      this.emit('log', { level: 'warn', message: `[warmup] Impossible de retirer le marqueur de session restreinte : ${e.message}` });
    }
  }

  /**
   * Persiste l'état de session du contexte dont l'accès vient d'être CONFIRMÉ.
   *
   * Écriture ATOMIQUE : l'état est d'abord écrit dans un fichier temporaire, son
   * contenu est validé (JSON lisible), puis il REMPLACE atomiquement le fichier
   * global via un `rename`. Un remplacement ne peut donc jamais laisser un
   * `global-session.json` partiellement écrit (crash/disque plein en cours
   * d'écriture) et l'ancien fichier reste intact tant que le nouveau n'est pas
   * complet.
   *
   * Cette méthode REMPLACE toujours le fichier global existant : un ancien
   * fichier (potentiellement périmé/empoisonné) ne doit PAS empêcher
   * l'enregistrement d'une session fraîchement validée (correction F2). Avant,
   * la sauvegarde était conditionnée à l'ABSENCE du fichier — un ancien
   * `global-session.json` bloquait donc tout rafraîchissement de session.
   *
   * Ne lève jamais : renvoie un résultat explicite. L'appelant NE DOIT PAS lever
   * le marqueur de restriction si `ok === false` (l'ancienne session resterait
   * alors réutilisable sans qu'une session saine ne l'ait remplacée).
   * @param {import('playwright').BrowserContext} ctx
   * @param {string} [where] étiquette de journalisation (warmup / post_captcha)
   * @returns {Promise<{ok:boolean, path:string|null, error:string|null}>}
   */
  async _persistValidatedSession(ctx, where = 'warmup') {
    const tmpPath = `${GLOBAL_SESSION_PATH}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(GLOBAL_SESSION_PATH), { recursive: true });
      await ctx.storageState({ path: tmpPath });
      // Ne pas confondre « le fichier existe » et « son contenu est valide » : un
      // storageState tronqué serait inutilisable (voire dangereux) au prochain job.
      JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      fs.renameSync(tmpPath, GLOBAL_SESSION_PATH);
      this.emit('log', { level: 'debug', message: `[${where}] Session validée persistée : ${GLOBAL_SESSION_PATH} (${formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size)})` });
      return { ok: true, path: GLOBAL_SESSION_PATH, error: null };
    } catch (e) {
      // Nettoyage du fichier temporaire : aucune écriture partielle ne doit rester.
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* nettoyage best-effort */ }
      this.emit('log', { level: 'warn', message: `[${where}] Sauvegarde de la session validée IMPOSSIBLE : ${e.message} — ancienne session conservée, protection maintenue.` });
      return { ok: false, path: null, error: e.message };
    }
  }

  /**
   * Renvoie le chemin de session globale à RÉUTILISER, ou null. Si la session est
   * marquée restreinte, on ne la réutilise PAS : Vendra repart d'un contexte
   * vierge (nouveaux cookies, nouvelle résolution CAPTCHA si nécessaire) au lieu
   * de traîner des cookies anti-bot empoisonnés.
   * @returns {string|null}
   */
  _reusableSessionPath() {
    if (!fs.existsSync(GLOBAL_SESSION_PATH)) return null;
    if (fs.existsSync(RESTRICTED_SESSION_FLAG_PATH)) {
      this.emit('log', { level: 'warn', message: '[warmup] Session globale ignorée : elle est marquée RESTREINTE (accès refusé la dernière fois). Reprise sur un contexte vierge.' });
      return null;
    }
    return GLOBAL_SESSION_PATH;
  }



  // Détecte un CAPTCHA / blocage sur la page. Vérifie plusieurs vecteurs :
  // 1) texte de la page (BLOCK_MARKERS)
  // 2) iframes Arkose/FunCaptcha/Cloudflare (cross-origin → non lisibles via innerText)
  // 3) URL de la page (redirection vers /captcha, /challenge, etc.)
  // 4) challenge Cloudflare (élément #challenge-form, .cf-turnstile)
  // 5) page de refus CloudFront (« Request blocked … Generated by cloudfront »)
  // Retourne un booléen pour compatibilité ; `_detectAccessBlock` donne le détail.
  async _checkCaptcha(page) {
    const res = await this._detectAccessBlock(page);
    return res.blocked;
  }

  /**
   * Classe le refus d'accès d'une page. Distingue un CAPTCHA (défi humain) d'une
   * page de refus CloudFront/anti-bot (blocage périphérique, sans défi résoluble),
   * de la page officielle « Accès temporairement restreint » (HTTP 200, refus
   * durable que la résolution d'un défi ne lève PAS) et d'un blocage HTTP nu
   * (403/429 sans contenu exploitable).
   * @param {import('playwright').Page} page
   * @param {number|null} [httpStatus]
   * @returns {Promise<{blocked:boolean, kind:'cloudfront'|'restricted'|'captcha'|'http'|null, marker:string|null, provider:string|null, reason:string|null}>}
   */
  async _detectAccessBlock(page, httpStatus = null) {
    const none = { blocked: false, kind: null, marker: null, provider: null, reason: null };
    try {
      const currentUrl = page.url();
      // URL de défi : on ne teste QUE le CHEMIN (pas la query) — sinon une
      // recherche contenant « verify »/« captcha » dans son texte serait classée
      // comme défi (faux positif → fenêtre CAPTCHA inutile).
      let captchaUrlMatch = false;
      try { captchaUrlMatch = /captcha|challenge|verify|blocked|restreint/i.test(new URL(currentUrl).pathname); }
      catch { captchaUrlMatch = /captcha|challenge|blocked/i.test(currentUrl); }

      const result = await page.evaluate(() => {
        const text = (document.title + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const captchaIframe = iframes.find((f) => {
          const src = (f.src || '').toLowerCase();
          return src.includes('arkoselabs') || src.includes('funcaptcha') ||
                 src.includes('hcaptcha') || src.includes('recaptcha') ||
                 src.includes('challenges.cloudflare') || src.includes('turnstile') ||
                 src.includes('captcha');
        });

        const cfChallenge = !!document.querySelector('#challenge-form, .cf-turnstile, #cf-challenge-running, .cf-challenge-form');

        // Cartes d'annonces : sélecteurs STRICTS. `[data-test-id*="ad"]` (sous-
        // chaîne) comptait des éléments sans rapport (`header`, `badge`…) → une
        // page de restriction était vue comme une page de résultats (faux négatif).
        // On exige un lien de détail `/ad/` OU un `data-test-id` EXACT de carte.
        const adCards = document.querySelectorAll(
          'a[href*="/ad/"], [data-test-id="ad"], [data-test-id="adcard"], [data-test-id="ad-card"], [data-test-id="aditem"], [data-test-id="ad-item"], [data-test-id="listing"], [data-test-id="listing-card"]'
        ).length;

        return { text, hasCaptchaIframe: !!captchaIframe, cfChallenge, adCards };
      });

      // Marqueurs de défi dérivés du TEXTE (source unique, testable) :
      //  - SPÉCIFIQUES : quasi impossibles sur une page de résultats ;
      //  - GÉNÉRIQUES : présents aussi dans du contenu légitime (« aspirateur
      //    robot », « vérification »…) → retenus SEULEMENT sans carte d'annonce.
      const SPECIFIC_MARKERS = ['captcha', 'captcha-delivery', 'are you human', 'verify you are human', 'checking your browser', 'enable javascript and cookies to continue'];
      const GENERIC_MARKERS = ['robot', 'vérification', 'verification', 'restreint', 'unusual traffic', 'unusual activity', 'vitesse surhumaine'];
      const specificMatched = SPECIFIC_MARKERS.find((m) => result.text.includes(m)) || null;
      const genericMatched = GENERIC_MARKERS.find((m) => result.text.includes(m)) || null;

      // 1) Page officielle « Accès temporairement restreint » : c'est un refus
      //    DURABLE, PAS un CAPTCHA. La résolution d'un défi humain n'y change
      //    rien → on ne doit JAMAIS ouvrir une fenêtre CAPTCHA pour cette page.
      //    (Détectée AVANT le CAPTCHA car elle contient les mots « robot » et
      //    « vitesse surhumaine » qui, seuls, la feraient classer comme CAPTCHA.)
      //    Le marqueur est AUTORITAIRE : on ne conditionne PAS la classification
      //    au nombre de cartes détectées (un élément HTML parasite ne doit pas
      //    pouvoir masquer une restriction explicitement affichée par le site).
      const restriction = detectRestrictionPage(result.text);
      if (restriction.restricted) {
        const reason = `page « Accès temporairement restreint » (marqueur « ${restriction.marker} »)`;
        const err = createError(ErrorCodes.ACCESS_RESTRICTED, `Blocage détecté — ${reason}`, { url: currentUrl, reason, marker: restriction.marker });
        this.emit('log', { level: 'debug', message: `[access] [${err.code}] ${reason}.` });
        return { blocked: true, kind: 'restricted', marker: restriction.marker, provider: 'leboncoin', reason };
      }

      // 2) Refus CloudFront / anti-bot (page d'erreur servie même en HTTP 200).
      const cf = detectCloudFrontBlock(result.text);
      if (cf.blocked) {
        const reason = `page de refus ${cf.provider} (marqueur « ${cf.marker} »)`;
        const err = createError(
          cf.provider === 'cloudfront' ? ErrorCodes.HTTP_ACCESS_REFUSED : ErrorCodes.CAPTCHA_DETECTED,
          `Blocage détecté — ${reason}`, { url: currentUrl, reason, marker: cf.marker, provider: cf.provider });
        this.emit('log', { level: 'debug', message: `[access] [${err.code}] ${reason}.` });
        return { blocked: true, kind: cf.provider === 'cloudfront' ? 'cloudfront' : 'captcha', marker: cf.marker, provider: cf.provider, reason };
      }

      // 3) CAPTCHA / défi humain.
      //    - marqueur SPÉCIFIQUE, iframe CAPTCHA, challenge Cloudflare ou URL de
      //      défi → défi (quelle que soit la présence de cartes) ;
      //    - marqueur GÉNÉRIQUE (« robot », « vérification »…) : retenu SEULEMENT
      //      sans carte d'annonce. Sinon une page de RÉSULTATS contenant ces mots
      //      (annonce « aspirateur robot »…) serait prise pour un CAPTCHA → fenêtre
      //      CAPTCHA ouverte inutilement.
      const genericCaptcha = !!(genericMatched && result.adCards === 0);
      const captchaBlocked = !!(specificMatched || result.hasCaptchaIframe || result.cfChallenge || captchaUrlMatch || genericCaptcha);
      if (captchaBlocked) {
        const reason = specificMatched ? `texte "${specificMatched}"`
          : result.hasCaptchaIframe ? 'iframe CAPTCHA détectée'
          : result.cfChallenge ? 'challenge Cloudflare'
          : captchaUrlMatch ? `URL suspecte (${currentUrl})`
          : `texte "${genericMatched}" (sans annonce)`;
        const err = createError(ErrorCodes.CAPTCHA_DETECTED, `Blocage détecté — ${reason}`, { url: currentUrl, reason });
        this.emit('log', { level: 'debug', message: `[access] [${err.code}] Blocage détecté — ${reason}.` });
        return { blocked: true, kind: 'captcha', marker: specificMatched || genericMatched || null, provider: 'anti-bot', reason };
      }

      // 4) Blocage HTTP nu (403/429/5xx) sans CAPTCHA ni page CloudFront identifiable.
      if (typeof httpStatus === 'number' && httpStatus >= 400) {
        const reason = `HTTP ${httpStatus}`;
        return { blocked: true, kind: 'http', httpStatus, marker: null, provider: null, reason };
      }
      return none;
    } catch (e) {
      // 🛑 Une erreur d'ÉVALUATION ne prouve PAS que l'accès est rétabli : le DOM
      // peut être indisponible (contexte/page fermé, navigation en cours). On ne
      // déclare donc PAS « non bloqué » (ancien message trompeur « considéré comme
      // non bloqué ») : on renvoie un état INDÉTERMINÉ que l'appelant doit traiter
      // comme tel (ne jamais valider l'accès sur cette seule base).
      this.emit('log', { level: 'warn', message: `[access] Évaluation du contenu IMPOSSIBLE (${e.message}) — état INDÉTERMINÉ (ni « bloqué », ni « non bloqué »).` });
      return { blocked: false, kind: null, marker: null, provider: null, reason: 'evaluation_failed', evaluationFailed: true };
    }
  }

  /**
   * Classification PURE d'une observation d'accès (sonde HTTP isolée OU DOM du
   * navigateur). Extraite pour être testable sans Playwright et pour documenter
   * les règles de diagnostic (correction F1).
   *
   * `source` distingue l'origine de l'observation :
   *   - `'probe'`   : client HTTP associé au contexte (`ctx.request.get`) — il ne
   *     partage PAS nécessairement tous les aspects réseau/rendu de la navigation
   *     Chromium (TLS, HTTP/2, exécution JS). Une observation ISOLÉE ne doit donc
   *     jamais, à elle seule, affirmer que le NAVIGATEUR est restreint.
   *   - `'browser'` : DOM réellement affiché dans Chromium — preuve positive forte
   *     pour CETTE navigation.
   *
   * Règles :
   *   1. page de restriction explicite → `access_restricted` (quelle que soit la source) ;
   *   2. page CloudFront reconnue → `cloudfront_blocked` ;
   *   3. statut ≥ 400 : classé par CODE (403 / 429 / 5xx), sans présumer CloudFront ;
   *   4. défi CAPTCHA reconnu → `captcha_required` ;
   *   5. page de résultats réelle (cartes d'annonces) → `results_ok` ;
   *   6. sinon → `unknown_page` (indéterminé, JAMAIS un succès).
   *
   * RÈGLE IMPÉRATIVE : un HTTP 200 ne valide JAMAIS à lui seul l'accès ; zéro
   * annonce sans marqueur fiable n'est PAS une restriction (page vide / chargement
   * incomplet / changement de structure restent possibles).
   * @param {object} o
   * @param {number|null} o.status
   * @param {boolean} o.restricted
   * @param {string|null} [o.restrictionMarker]
   * @param {boolean} o.cloudfront
   * @param {boolean} o.captcha
   * @param {boolean} o.hasResults
   * @param {number} [o.adCards]
   * @param {'probe'|'browser'} [o.source]
   * @returns {{outcome:string, ok:boolean, httpError:number|null}}
   */
  _classifyAccessObservation(o) {
    const status = typeof o.status === 'number' ? o.status : null;
    let outcome;
    if (o.restricted) outcome = 'access_restricted';
    else if (o.cloudfront) outcome = 'cloudfront_blocked';
    else if (status !== null && status >= 400) {
      // Le code HTTP identifie le STATUT, pas la technologie qui l'a produit : un
      // 403/429/5xx nu n'est PAS présumé CloudFront.
      outcome = status === 403 ? 'http_403'
        : status === 429 ? 'http_429'
        : status >= 500 ? 'http_5xx'
        : 'http_error';
    } else if (o.captcha) outcome = 'captcha_required';
    else if (o.hasResults) outcome = 'results_ok';
    else outcome = 'unknown_page';
    return {
      outcome,
      // `ok` = accès réellement confirmé (page de résultats RÉELLE). Indépendant de
      // la source : une page de résultats vue dans le DOM comme dans la sonde est
      // une preuve positive ; tout le reste (200 vide, statut d'erreur, inconnu) ne
      // l'est PAS.
      ok: outcome === 'results_ok',
      httpError: status !== null && status >= 400 ? status : null,
    };
  }

  /**
   * Décide si une restriction observée par la SONDE HTTP ISOLÉE peut être traitée
   * comme un refus DÉFINITIF du navigateur (correction F1).
   *
   * Le client de la sonde (`ctx.request.get`) n'est PAS la navigation Chromium :
   * s'il voit la page de restriction alors que le navigateur, lui, a rendu une
   * page SANS marqueur de restriction, les deux observations sont CONTRADICTOIRES.
   * On ne force alors aucun verdict : état prudent « accès non vérifié » (aucune
   * session persistée), le refus n'étant pas confirmé par le navigateur.
   *
   * En revanche, si le navigateur n'a produit AUCUNE observation (navigation
   * échouée), la sonde est la seule preuve disponible : le refus est traité comme
   * définitif (comportement historique conservé).
   *
   * @param {object} o
   * @param {boolean} o.browserObserved - le navigateur a-t-il rendu une page exploitable ?
   * @returns {{definitive:boolean, reason:string, blockCode:string, stopReason:string}}
   */
  _resolveProbeRestriction({ browserObserved }) {
    if (browserObserved) {
      // Conflit navigateur (pas de restriction vue) vs sonde (restriction vue).
      return { definitive: false, reason: 'unverified', blockCode: ErrorCodes.ACCESS_UNVERIFIED, stopReason: 'probe_restriction_unconfirmed' };
    }
    return { definitive: true, reason: 'restricted', blockCode: ErrorCodes.ACCESS_RESTRICTED, stopReason: 'access_restricted' };
  }

  /**
   * Sonde HTTP ISOLÉE d'accès : rejoue une requête HTTP (client associé au
   * contexte, avec les cookies et en-têtes client) vers l'URL de recherche et
   * renvoie le statut observé AINSI QUE la nature du contenu.
   *
   * ⚠️ LIMITE (correction F1) : `ctx.request.get` est un client HTTP distinct de
   * la navigation Chromium ; il peut ne pas partager tous les aspects du
   * traitement réseau (TLS/HTTP2) ni le rendu JS. Une réponse `access_restricted`
   * ou `unknown_page` de la sonde est donc un INDICE, pas une preuve que le
   * navigateur est restreint. Les appelants ne doivent traiter la restriction
   * comme définitive que si le NAVIGATEUR l'a aussi observée ; sinon l'état
   * prudent `ACCESS_UNVERIFIED` (aucune session persistée) s'applique.
   *
   * Renvoie un résultat STRUCTURÉ (`outcome` ∈ results_ok / captcha_required /
   * access_restricted / cloudfront_blocked / http_403 / http_429 / http_5xx /
   * http_error / network_error / unknown_page). Best-effort : ne jette jamais.
   * @param {import('playwright').BrowserContext} ctx
   * @param {string} url
   */
  async _probeAccessStatus(ctx, url) {
    try {
      const resp = await ctx.request.get(url, {
        // En-têtes d'un vrai document GET (Accept + Sec-Fetch-* + Referer) : la
        // sonde doit ressembler à un clic utilisateur, pas à un fetch « nu ».
        headers: clientHeadersFor(this._profile),
        maxRedirects: 5,
        timeout: 15000,
      });
      const status = resp.status();
      let body = '';
      try { body = await resp.text(); } catch { /* corps illisible → contenu inconnu */ }
      const restriction = detectRestrictionPage(body);
      const cf = detectCloudFrontBlock(body);
      const adCards = countAdCards(body);
      const hasResults = looksLikeResultsPage(body);
      // CAPTCHA/défi réellement présent dans le corps (indépendant du contexte DOM).
      const captcha = !restriction.restricted && !cf.blocked && ACCESS_BLOCK_MARKERS.some((m) => body.toLowerCase().includes(m));

      const cls = this._classifyAccessObservation({
        status, restricted: restriction.restricted, restrictionMarker: restriction.marker,
        cloudfront: cf.blocked, captcha, hasResults, adCards, source: 'probe',
      });

      return {
        status,
        source: 'probe',
        ok: cls.ok,
        outcome: cls.outcome,
        httpError: cls.httpError,
        restricted: restriction.restricted,
        cloudfront: cf.blocked,
        captcha,
        hasResults,
        adCards,
        marker: restriction.marker || cf.marker || null,
      };
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[access] Sonde HTTP impossible : ${e.message}` });
      return { status: null, source: 'probe', ok: false, outcome: 'network_error', httpError: null, restricted: false, cloudfront: false, captcha: false, hasResults: false, adCards: 0, marker: null };
    }
  }

  // Pré-check Leboncoin : navigue en invisible, et si un CAPTCHA est détecté,
  // bascule dans une fenêtre VISIBLE pour résolution humaine, puis revient en
  // invisible. La session validée est persistée dans GLOBAL_SESSION_PATH.
  async _warmupSession(browser, checkUrl) {
    this.emit('log', { level: 'info', message: '🔍 Pré-check session : navigation invisible vers Leboncoin...' });
    this.emit('log', { level: 'debug', message: `[warmup] URL de vérification : ${checkUrl} | session existante : ${fs.existsSync(GLOBAL_SESSION_PATH) ? 'OUI (' + formatBytes(fs.statSync(GLOBAL_SESSION_PATH).size) + ')' : 'NON'}` });

    const ctxOpts = this._baseContextOptions();
    const reusableSession = this._reusableSessionPath();
    if (reusableSession) {
      ctxOpts.storageState = reusableSession;
      this.emit('log', { level: 'info', message: '🔑 Chargement de la session globale (Master Session)...' });
    } else if (fs.existsSync(GLOBAL_SESSION_PATH)) {
      this.emit('log', { level: 'info', message: '🔑 Session globale présente mais ignorée (marquée restreinte) — contexte vierge.' });
    }

    const { ctx, p } = await this._newStealthContext(browser, ctxOpts);
    // 🛑 FIX « session déclarée valide à tort au 1er lancement » :
    // `waitUntil: networkidle` peut ne JAMAIS se stabiliser (le site garde des
    // connexions ouvertes) → la navigation échoue au bout de 20 s, `warmupStatus`
    // reste `null`, aucun CAPTCHA n'est visible… et un pré-check naïf déclarait
    // pourtant « ✅ Pré-check OK ». La session était donc considérée validée sans
    // AUCUN signal observé. On distingue explicitement l'échec de navigation et on
    // le rattrape par une sonde HTTP objective (voir plus bas).
    //
    // REPRISE BORNÉE : un refus anti-bot (403/429) peut être TRANSITOIRE (défi
    // servi une seule fois). L'ancien moteur enchaînait naturellement plusieurs
    // navigations (pré-check PUIS capture), ce qui absorbait ces refus passagers ;
    // le pré-check récent, lui, s'arrêtait sur le PREMIER 403. On réessaie donc la
    // navigation de pré-check un PETIT nombre de fois (jamais une boucle), en
    // conservant le DERNIER statut observé. Un refus EXPLICITE et durable
    // (CloudFront / « Accès temporairement restreint ») n'est PAS « résolu » par
    // ces essais : il est classé honnêtement ensuite par `_detectAccessBlock`.
    const WARMUP_NAV_ATTEMPTS = 3;
    const WARMUP_NAV_RETRY_DELAY_MS = 1500;
    let warmupStatus = null;
    let navigationFailed = false;
    for (let attempt = 1; attempt <= WARMUP_NAV_ATTEMPTS; attempt++) {
      const t0Goto = Date.now();
      let attemptStatus = null;
      let attemptFailed = false;
      await p.goto(checkUrl, { waitUntil: 'networkidle', timeout: 20000 })
        .then((resp) => { attemptStatus = resp ? resp.status() : null; })
        .catch(async (e) => {
          attemptFailed = true;
          this.emit('log', { level: 'warn', message: `Pré-check : navigation initiale impossible (tentative ${attempt}/${WARMUP_NAV_ATTEMPTS}, ${e.message}).` });
          this.emit('log', { level: 'debug', message: `[warmup] Détail erreur goto : ${describeError(e)}` });
          // Repli : on tente une navigation plus permissive pour OBTENIR un statut
          // HTTP réel (networkidle peut être trompeur sur une page à réseau actif).
          await p.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .then((resp) => { attemptStatus = resp ? resp.status() : null; })
            .catch((e2) => {
              this.emit('log', { level: 'warn', message: `Pré-check : repli domcontentloaded impossible (${e2.message}).` });
              this.emit('log', { level: 'debug', message: `[warmup] Détail erreur goto (repli) : ${describeError(e2)}` });
            });
        });
      warmupStatus = attemptStatus;
      navigationFailed = attemptFailed;
      this.emit('log', { level: 'debug', message: `[warmup] Navigation pré-check (tentative ${attempt}/${WARMUP_NAV_ATTEMPTS}) terminée en ${formatMs(Date.now() - t0Goto)}${warmupStatus ? ` — HTTP ${warmupStatus}` : ' — statut inconnu'}.` });
      // Accès abouti (HTTP < 400) ou statut inconnu → on passe à la classification.
      // On ne réessaie QUE sur un refus HTTP ≥ 400 potentiellement transitoire.
      if (typeof attemptStatus !== 'number' || attemptStatus < 400) break;
      if (attempt < WARMUP_NAV_ATTEMPTS) {
        this.emit('log', { level: 'info', message: `[warmup] HTTP ${attemptStatus} au pré-check — nouvelle tentative (${attempt + 1}/${WARMUP_NAV_ATTEMPTS}) dans ${WARMUP_NAV_RETRY_DELAY_MS / 1000}s.` });
        await sleep(WARMUP_NAV_RETRY_DELAY_MS);
      }
    }

    // Délai supplémentaire : Leboncoin peut injecter le CAPTCHA en JS après
    // networkidle (chargement différé de l'iframe Arkose). 3s au lieu de 1.5s.
    await sleep(3000);

    // Un blocage peut se manifester par un CAPTCHA (texte/iframe/URL), une page
    // de refus CloudFront (servie même en HTTP 200) OU un code HTTP d'erreur
    // (403/429). `_detectAccessBlock` classe le type pour décider de l'action.
    const accessBlock = await this._detectAccessBlock(p, warmupStatus);
    const blocked = accessBlock.blocked;

    if (blocked) {
      this.emit('log', { level: 'warn', message: `[warmup] Refus d'accès détecté (${accessBlock.kind}${accessBlock.reason ? ' — ' + accessBlock.reason : ''}${warmupStatus ? `, HTTP ${warmupStatus}` : ''}).` });
    }

    // Observation du NAVIGATEUR pour cette navigation : un statut HTTP de
    // navigation a été obtenu (même 200). Sert à distinguer une observation
    // navigateur d'une observation de la sonde HTTP isolée (correction F1).
    const browserObserved = warmupStatus !== null;

    // 🛑 Si AUCUN statut HTTP n'a été observé (navigation échouée/instable), le
    // contenu seul ne suffit PAS à déclarer l'accès valide. On exige une preuve
    // OBJECTIVE via une sonde HTTP réelle avant de dire « session validée ».
    if (!blocked && warmupStatus === null) {
      const probe = await this._probeAccessStatus(ctx, checkUrl);
      this.emit('log', { level: 'debug', message: `[warmup] Statut de navigation inconnu — sonde objective : HTTP ${probe.status ?? '?'} → ${probe.outcome}.` });
      if (probe.outcome === 'access_restricted') {
        // Ici le navigateur n'a produit AUCUNE observation (navigation échouée) :
        // la sonde est la seule preuve → refus traité comme définitif (historique).
        const restrictedErr = createError(
          ErrorCodes.ACCESS_RESTRICTED,
          `Accès restreint : page officielle « ${probe.marker} » (HTTP ${probe.status ?? '?'}) — aucun défi à résoudre.`,
          { url: checkUrl, status: probe.status, marker: probe.marker });
        this.emit('log', { level: 'warn', message: `⛔ [${restrictedErr.code}] ${restrictedErr.message}` });
        this._markSessionRestricted('warmup_restricted');
        this._logAccessDiag({ where: 'warmup', url: checkUrl, status: probe.status, outcome: probe.outcome, restricted: true, restrictedMarker: probe.marker, adCards: probe.adCards, source: probe.source, decision: 'stop', persist: false, stopReason: 'access_restricted' });
        await p.close().catch(() => {});
        await ctx.close().catch(() => {});
        return { verified: false, reason: 'restricted', blockKind: 'restricted', blockCode: ErrorCodes.ACCESS_RESTRICTED };
      }
      // Un accès n'est validé QUE si la sonde confirme une page de résultats RÉELLE.
      // Un HTTP 200 vide/indéterminé n'est PAS une validation.
      if (!probe.ok) {
        const unverifiedErr = createError(
          ErrorCodes.ACCESS_UNVERIFIED,
          `Accès non vérifié : aucune page de résultats confirmée (HTTP ${probe.status ?? '?'}, ${probe.outcome}).`,
          { url: checkUrl, status: probe.status, outcome: probe.outcome, navigationFailed });
        this.emit('log', { level: 'warn', message: `⛔ [${unverifiedErr.code}] ${unverifiedErr.message}` });
        this._logAccessDiag({ where: 'warmup', url: checkUrl, status: probe.status, outcome: probe.outcome, cloudfront: probe.cloudfront, captcha: probe.captcha, hasResults: probe.hasResults, adCards: probe.adCards, source: probe.source, decision: 'stop', persist: false, stopReason: 'access_unverified' });
        await p.close().catch(() => {});
        await ctx.close().catch(() => {});
        return { verified: false, reason: 'unverified', blockKind: 'http', blockCode: ErrorCodes.ACCESS_UNVERIFIED };
      }
    }

    if (!blocked) {
      // 🛑 Un HTTP < 400 ne suffit PAS : on exige une page de résultats RÉELLE.
      // On compte d'abord les cartes d'annonces STRICTES dans le DOM ; si le DOM
      // ne prouve rien (page JS vide, structure inconnue), on confirme par la
      // sonde HTTP objective. Un 200 sans résultats n'est PAS un accès validé.
      let resultsConfirmed = false;
      let confirmInfo = { where: 'warmup', url: checkUrl, status: warmupStatus, source: 'browser' };
      try {
        const domCardsRaw = await p.evaluate(() => {
          try {
            return document.querySelectorAll('a[href*="/ad/"], [data-test-id="ad"], [data-test-id="adcard"], [data-test-id="ad-card"], [data-test-id="aditem"], [data-test-id="ad-item"], [data-test-id="listing"], [data-test-id="listing-card"]').length;
          } catch { return 0; }
        });
        const domCards = typeof domCardsRaw === 'number' ? domCardsRaw : 0;
        confirmInfo.adCards = domCards;
        // Une page de résultats RÉELLE vue dans le NAVIGATEUR est une preuve
        // positive d'accès pour CETTE navigation (règle F1 n°1). On renseigne
        // AUSSI `hasResults` : sinon le diagnostic affichait `results_ok` avec
        // `resultsMarkers=false` (contradiction trompeuse — les cartes DOM
        // confirmaient l'accès mais le drapeau de marqueurs restait faux).
        if (domCards > 0) { resultsConfirmed = true; confirmInfo.outcome = 'results_ok'; confirmInfo.hasResults = true; }
      } catch { /* DOM indisponible → confirmation par sonde */ }

      if (!resultsConfirmed) {
        const probe = await this._probeAccessStatus(ctx, checkUrl);
        confirmInfo = { where: 'warmup', url: checkUrl, status: probe.status, outcome: probe.outcome, restricted: probe.restricted, restrictedMarker: probe.marker, cloudfront: probe.cloudfront, captcha: probe.captcha, hasResults: probe.hasResults, adCards: probe.adCards, source: probe.source };
        if (probe.outcome === 'access_restricted') {
          // Conflit possible : le navigateur (HTTP < 400, aucun marqueur de
          // restriction) contredit la sonde isolée (restriction). On ne force pas
          // de verdict définitif → « accès non vérifié », aucune session persistée.
          const decision = this._resolveProbeRestriction({ browserObserved });
          if (decision.definitive) {
            this._markSessionRestricted('warmup_restricted');
            this._logAccessDiag({ ...confirmInfo, decision: 'stop', persist: false, stopReason: decision.stopReason });
            await p.close().catch(() => {});
            await ctx.close().catch(() => {});
            return { verified: false, reason: decision.reason, blockKind: 'restricted', blockCode: decision.blockCode };
          }
          this.emit('log', { level: 'warn', message: `⛔ [${ErrorCodes.ACCESS_UNVERIFIED}] Pré-check : la sonde HTTP signale une restriction, mais le navigateur n'a affiché AUCUN marqueur de restriction (observations contradictoires) — accès NON confirmé, session NON persistée.` });
          this._logAccessDiag({ ...confirmInfo, decision: 'stop', persist: false, stopReason: decision.stopReason });
          await p.close().catch(() => {});
          await ctx.close().catch(() => {});
          return { verified: false, reason: decision.reason, blockKind: 'http', blockCode: decision.blockCode };
        }
        if (!probe.ok) {
          this.emit('log', { level: 'warn', message: `⛔ [${ErrorCodes.ACCESS_UNVERIFIED}] Pré-check : aucune page de résultats confirmée (HTTP ${probe.status ?? '?'}, ${probe.outcome}) — session NON validée.` });
          this._logAccessDiag({ ...confirmInfo, decision: 'stop', persist: false, stopReason: 'access_unverified' });
          await p.close().catch(() => {});
          await ctx.close().catch(() => {});
          return { verified: false, reason: 'unverified', blockKind: 'http', blockCode: ErrorCodes.ACCESS_UNVERIFIED };
        }
        resultsConfirmed = true;
      }

      // Accès normal confirmé. DEUX états distincts (ne pas les confondre) :
      //   (1) accès confirmé pour la session courante ;
      //   (2) session DURABLEMENT persistée pour les prochains jobs.
      // On persiste d'abord (remplacement atomique de l'ancien fichier : correction
      // F2), puis on ne lève le marqueur de restriction QUE si la persistance a
      // réussi — sinon l'ancienne session resterait réutilisable sans remplaçant sain.
      const persistRes = await this._persistValidatedSession(ctx, 'warmup');
      if (persistRes.ok) this._clearSessionRestricted();
      else this.emit('log', { level: 'warn', message: '[warmup] Accès confirmé pour cette session, mais la session n\'a PAS pu être persistée durablement — le marqueur de restriction est conservé.' });
      this._logAccessDiag({ ...confirmInfo, decision: 'validated', persist: persistRes.ok, stopReason: persistRes.ok ? null : 'session_persist_failed' });
      await p.close().catch(() => {});
      await ctx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ Pré-check OK : page de résultats confirmée, reprise invisible.' });
      return { verified: true, reason: 'no_captcha' };
    }

    // Refus CloudFront / anti-bot, page « Accès temporairement restreint » OU
    // blocage HTTP nu (403/429) sans défi résoluble : ouvrir une fenêtre CAPTCHA
    // serait stérile (rien à résoudre, ou la restriction ne dépend PAS d'un défi).
    // On arrête proprement avec un état explicite.
    if (accessBlock.kind === 'cloudfront' || accessBlock.kind === 'http' || accessBlock.kind === 'restricted') {
      const isRestricted = accessBlock.kind === 'restricted';
      const unverifiedErr = createError(
        isRestricted ? ErrorCodes.ACCESS_RESTRICTED : ErrorCodes.ACCESS_UNVERIFIED,
        isRestricted
          ? `Accès restreint : page officielle « ${accessBlock.marker} » (${accessBlock.provider}). Aucun défi à résoudre — attendez ou changez de réseau.`
          : accessBlock.kind === 'cloudfront'
            ? `Accès non vérifié : page de refus ${accessBlock.provider} (${accessBlock.marker}). Nouvelle tentative plus tard.`
            : `Accès non vérifié : blocage HTTP ${accessBlock.reason} sans défi résoluble. Nouvelle tentative plus tard.`,
        { url: checkUrl, kind: accessBlock.kind, marker: accessBlock.marker });
      this.emit('log', { level: 'warn', message: `⛔ [${unverifiedErr.code}] ${unverifiedErr.message}` });
      if (isRestricted) this._markSessionRestricted('warmup_restricted');
      this._logAccessDiag({
        where: 'warmup', url: checkUrl, status: warmupStatus, outcome: isRestricted ? 'access_restricted' : (accessBlock.kind === 'cloudfront' ? 'cloudfront_blocked' : 'unknown_page'),
        restricted: isRestricted, restrictedMarker: isRestricted ? accessBlock.marker : null, cloudfront: accessBlock.kind === 'cloudfront',
        decision: 'stop', persist: false, stopReason: isRestricted ? 'access_restricted' : 'access_unverified',
      });
      await p.close().catch(() => {});
      await ctx.close().catch(() => {});
      return {
        verified: false,
        reason: isRestricted ? 'restricted' : accessBlock.kind === 'cloudfront' ? 'cloudfront_blocked' : 'http_blocked',
        blockKind: accessBlock.kind,
        blockCode: isRestricted ? ErrorCodes.ACCESS_RESTRICTED : ErrorCodes.ACCESS_UNVERIFIED,
      };
    }

    // Blocage CAPTCHA (défi humain) : ferme le contexte invisible avant d'ouvrir
    // une fenêtre VISIBLE pour résolution humaine.
    await p.close().catch(() => {});
    await ctx.close().catch(() => {});

    const captchaDetectedErr = createError(ErrorCodes.CAPTCHA_DETECTED, 'Blocage CAPTCHA détecté — affichage de la fenêtre (résolution humaine requise)');
    this.emit('log', { level: 'warn', message: `⚠️ [${captchaDetectedErr.code}] Blocage CAPTCHA détecté — affichage de la fenêtre (résolution humaine requise).` });
    this.emit('log', { level: 'info', message: '👤 Une fenêtre va s\'ouvrir. Résolvez le CAPTCHA manuellement — le scraping reprendra automatiquement.' });
    this.emit('progress', { currentPage: 0, totalPages: 0, percent: 0, status: 'CAPTCHA : veuillez résoudre dans la fenêtre ouverte...' });

    // Relance un navigateur visible (le navigateur headless actuel ne peut pas
    // devenir visible à chaud) afin que l'utilisateur puisse interagir.
    const visibleBrowser = await chromium.launch(this._launchOptions(false));
    try {
      const vOpts = this._baseContextOptions();
      const reusableVisible = this._reusableSessionPath();
      if (reusableVisible) vOpts.storageState = reusableVisible;
      const { ctx: vCtx, p: vPage } = await this._newStealthContext(visibleBrowser, vOpts);

      // 🛑 FIX CRITIQUE : suivre le statut HTTP en temps réel via les responses.
      // Avant, vStatus était figé à la navigation initiale (souvent 403) et jamais
      // mis à jour → la détection ne détectait JAMAIS la résolution et attendait
      // les 10 minutes complètes. Maintenant on track la dernière réponse HTTP
      // document dynamiquement, ce qui permet de confirmer la résolution
      // (redirection post-CAPTCHA → HTTP 200).
      let latestHttpStatus = null;
      vPage.on('response', (resp) => {
        // Ne track que les réponses de navigation principale (document), pas les
        // sous-ressources (CSS/JS/images) qui peuvent renvoyer des codes trompeurs.
        if (resp.request().resourceType() === 'document') {
          latestHttpStatus = resp.status();
        }
      });

      let vStatus = null;
      await vPage.goto(checkUrl, { waitUntil: 'networkidle', timeout: 60000 })
        .then((resp) => { vStatus = resp ? resp.status() : null; latestHttpStatus = vStatus; })
        .catch((e) => {
          this.emit('log', { level: 'warn', message: `[warmup] Navigation fenêtre visible échouée : ${e.message}` });
        });

      // Attend que le CAPTCHA soit rendu avant de demander la résolution.
      await sleep(2000);

      // Vérifie le blocage : CAPTCHA (texte/iframe/URL) uniquement.
      // 🛑 On NE vérifie PLUS le statut HTTP figé (vStatus) pendant le polling :
      // il reste à 403 même après résolution car la navigation initiale est restée
      // bloquée. On se fie au contenu (iframe/texte/URL) qui change quand
      // l'utilisateur résout le CAPTCHA → la page se redirige vers les résultats.
      // `detectAccessBlock` classe aussi la page « Accès temporairement restreint »
      // (HTTP 200) : un défi qui disparaît en laissant cette page n'est PAS résolu.
      let restrictedDuringResolve = null;
      const checkVBlocked = async () => {
        const block = await this._detectAccessBlock(vPage, null);
        if (block.blocked && block.kind === 'restricted') restrictedDuringResolve = block;
        return block.blocked;
      };

      let isBlocked = await checkVBlocked();
      let waitAttempts = 0;
      const POLL_INTERVAL_MS = 2000; // 2s pour une détection rapide
      const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min max (sécurité)
      const startTime = Date.now();

      this.emit('log', { level: 'info', message: `[warmup] Fenêtre CAPTCHA ouverte. Résolvez le défi — la détection est automatique (polling ${POLL_INTERVAL_MS / 1000}s). Maximum ${Math.round(MAX_WAIT_MS / 60000)} min.` });

      // 🛑 FIX CLEF : on NE RECHARGE PAS la page pendant la résolution.
      // L'ancien code faisait vPage.reload() toutes les 2s → l'utilisateur ne
      // pouvait pas résoudre le CAPTCHA (la page se réinitialisait en continu).
      // On se contente de POLLER le contenu de la page (innerText/URL/iframes)
      // sans recharger, pour détecter quand l'utilisateur a résolu le défi.
      let confirmedClear = false;
      while (!confirmedClear && !this.isCancelled) {
        waitAttempts++;
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_WAIT_MS) {
          this.emit('log', { level: 'warn', message: `[warmup] Délai max (${Math.round(MAX_WAIT_MS / 60000)} min) atteint — abandon.` });
          break;
        }
        if (waitAttempts % 10 === 0) {
          const totalSec = Math.round((elapsed) / 1000);
          this.emit('log', { level: 'debug', message: `[warmup] En attente de résolution... (${totalSec}s écoulées).` });
        }
        await sleep(POLL_INTERVAL_MS);

        // Poll SANS reload : l'utilisateur résout le CAPTCHA → le DOM change
        // (les marqueurs disparaissent, l'iframe est retirée, ou l'URL change
        // suite à une redirection automatique).
        const stillBlocked = await checkVBlocked();

        // 🛑 Si la page « Accès temporairement restreint » est apparue, la
        // résolution du défi n'a PAS rétabli l'accès (refus durable). Continuer à
        // attendre ne servirait à rien : on sort de la boucle pour arrêter
        // proprement au lieu de faire patienter l'utilisateur 10 minutes.
        if (restrictedDuringResolve) {
          this.emit('log', { level: 'warn', message: `[warmup] Le défi a laissé place à la page « ${restrictedDuringResolve.marker} » — accès toujours restreint, arrêt.` });
          break;
        }

        if (!stillBlocked) {
          // 🛑 FIX : confirmation pour éviter les faux positifs.
          // Leboncoin peut brièvement retirer l'iframe CAPTCHA pendant une
          // transition (animation, redirection intermédiaire). On attend 2s et
          // on re-vérifie : si toujours non bloqué → résolution confirmée.
          this.emit('log', { level: 'debug', message: '[warmup] CAPTCHA semble résolu — confirmation (2s)...' });
          await sleep(2000);
          const recheck = await checkVBlocked();
          if (!recheck) {
            confirmedClear = true;
          } else {
            this.emit('log', { level: 'debug', message: '[warmup] Faux positif — CAPTCHA toujours présent, reprise de l\'attente.' });
          }
        }
      }

      if (this.isCancelled) {
        const cancelErr = createError(ErrorCodes.CAPTCHA_UNRESOLVED, 'Résolution annulée par l\'utilisateur');
        this.emit('log', { level: 'warn', message: `[warmup] [${cancelErr.code}] Résolution annulée par l\'utilisateur.` });
        // NE PAS persister la session : on est encore bloqué (CAPTCHA non résolu),
        // persister reviendrait à sauvegarder une session avec des cookies anti-bot
        // qui empoisonneraient tous les jobs suivants. On ferme sans storageState.
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'cancelled' };
      }

      if (!confirmedClear) {
        // Page « Accès temporairement restreint » apparue après la résolution :
        // le défi a disparu mais l'accès reste refusé. On ne persiste PAS la
        // session et on arrête avec un état explicite (attendre / changer de
        // réseau). Surtout, on ne relance PAS le scraping.
        if (restrictedDuringResolve) {
          const restrictedErr = createError(
            ErrorCodes.ACCESS_RESTRICTED,
            `CAPTCHA résolu mais accès toujours restreint (page « ${restrictedDuringResolve.marker} ») — session non persistée.`,
            { url: checkUrl, marker: restrictedDuringResolve.marker });
          this.emit('log', { level: 'warn', message: `[warmup] [${restrictedErr.code}] ${restrictedErr.message}` });
          await vPage.close().catch(() => {});
          await vCtx.close().catch(() => {});
          return { verified: false, reason: 'restricted', blockKind: 'restricted', blockCode: ErrorCodes.ACCESS_RESTRICTED };
        }
        // Timeout atteint sans résolution — on ne persiste pas la session.
        const timeoutErr = createError(ErrorCodes.CAPTCHA_TIMEOUT, `CAPTCHA non résolu dans le délai (${Math.round(MAX_WAIT_MS / 60000)} min) — session non persistée`);
        this.emit('log', { level: 'warn', message: `[warmup] [${timeoutErr.code}] CAPTCHA non résolu dans le délai — session non persistée.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'timeout' };
      }

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      this.emit('log', { level: 'info', message: `[warmup] ✅ [${ErrorCodes.CAPTCHA_DETECTED}] CAPTCHA résolu après ${elapsedSec}s (HTTP ${latestHttpStatus || '?'}) — stabilisation de la session...` });

      // FIX POST-CAPTCHA : attendre que la page se stabilise complètement
      // avant de persister la session. Leboncoin redirige ou recharge la page
      // après résolution — si on sauvegarde trop tôt, on capture une session
      // incomplète (sans le cookie de validation) → erreur au prochain goto.
      try {
        await vPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } catch { /* timeout networkidle acceptable */ }
      // Grace period courte : Leboncoin peut définir des cookies supplémentaires
      // après la redirection post-CAPTCHA.
      await sleep(1500);

      // Re-vérifie une dernière fois : Leboncoin peut afficher un 2e CAPTCHA
      // consécutif (anti-bot agressif) OU la page « Accès temporairement
      // restreint ». Dans les deux cas, on ne persiste PAS.
      const stillBlocked = await checkVBlocked();
      if (stillBlocked) {
        if (restrictedDuringResolve) {
          const restrictedErr = createError(
            ErrorCodes.ACCESS_RESTRICTED,
            `CAPTCHA résolu mais accès toujours restreint (page « ${restrictedDuringResolve.marker} ») — session non persistée.`,
            { url: checkUrl, marker: restrictedDuringResolve.marker });
          this.emit('log', { level: 'warn', message: `[warmup] [${restrictedErr.code}] ${restrictedErr.message}` });
          await vPage.close().catch(() => {});
          await vCtx.close().catch(() => {});
          return { verified: false, reason: 'restricted', blockKind: 'restricted', blockCode: ErrorCodes.ACCESS_RESTRICTED };
        }
        const secondCaptchaErr = createError(ErrorCodes.CAPTCHA_UNRESOLVED, 'Un 2e CAPTCHA consécutif est apparu — session non persistée. Relancez le scraping.');
        this.emit('log', { level: 'warn', message: `[warmup] [${secondCaptchaErr.code}] Un 2e CAPTCHA consécutif est apparu — session non persistée. Relancez le scraping.` });
        await vPage.close().catch(() => {});
        await vCtx.close().catch(() => {});
        return { verified: false, reason: 'second_captcha' };
      }

      // CONFIRMATION OBJECTIVE DE L'ACCÈS (anti-fausse-réussite) : la disparition
      // visuelle du défi ne PROUVE pas l'autorisation. On exige une page de
      // résultats RÉELLE : cartes d'annonces STRICTES dans le DOM de la fenêtre
      // visible, sinon sonde HTTP objective (statut + CONTENU). Un HTTP 200 vide,
      // « Accès temporairement restreint » ou un document inattendu n'est PAS un
      // accès rétabli → session NON persistée.
      let postCards = 0;
      try {
        const raw = await vPage.evaluate(() => {
          try {
            return document.querySelectorAll('a[href*="/ad/"], [data-test-id="ad"], [data-test-id="adcard"], [data-test-id="ad-card"], [data-test-id="aditem"], [data-test-id="ad-item"], [data-test-id="listing"], [data-test-id="listing-card"]').length;
          } catch { return 0; }
        });
        postCards = typeof raw === 'number' ? raw : 0;
      } catch { /* DOM indisponible → sonde */ }

      let probe = null;
      let confirmedOk = postCards > 0;
      if (!confirmedOk) {
        probe = await this._probeAccessStatus(vCtx, checkUrl);
        if (probe.outcome === 'access_restricted') {
          // La fenêtre visible a rendu une page SANS marqueur de restriction
          // (sinon on aurait déjà arrêté plus haut) : si la sonde isolée, elle,
          // voit une restriction, les observations sont CONTRADICTOIRES. On ne
          // force pas un verdict définitif → « défi non confirmé », session NON
          // persistée (correction F1).
          const decision = this._resolveProbeRestriction({ browserObserved: true });
          if (decision.definitive) {
            const restrictedErr = createError(
              ErrorCodes.ACCESS_RESTRICTED,
              `CAPTCHA résolu mais le serveur renvoie la page « ${probe.marker} » (HTTP ${probe.status ?? '?'}) — session non persistée.`,
              { url: checkUrl, status: probe.status, marker: probe.marker });
            this.emit('log', { level: 'warn', message: `[warmup] [${restrictedErr.code}] ${restrictedErr.message}` });
            this._markSessionRestricted('post_captcha_restricted');
            this._logAccessDiag({ where: 'post_captcha', url: checkUrl, status: probe.status, outcome: probe.outcome, restricted: true, restrictedMarker: probe.marker, adCards: probe.adCards, source: probe.source, decision: 'stop', persist: false, stopReason: decision.stopReason });
            await vPage.close().catch(() => {});
            await vCtx.close().catch(() => {});
            return { verified: false, reason: decision.reason, blockKind: 'restricted', blockCode: decision.blockCode };
          }
          const notConfirmedErr = createError(
            ErrorCodes.CAPTCHA_NOT_CONFIRMED,
            `Défi disparu mais observations contradictoires (sonde HTTP : restriction ; navigateur : aucun marqueur) — session non persistée.`,
            { url: checkUrl, status: probe.status, marker: probe.marker });
          this.emit('log', { level: 'warn', message: `[warmup] [${notConfirmedErr.code}] ${notConfirmedErr.message}` });
          this._logAccessDiag({ where: 'post_captcha', url: checkUrl, status: probe.status, outcome: probe.outcome, restricted: true, restrictedMarker: probe.marker, adCards: probe.adCards, source: probe.source, decision: 'stop', persist: false, stopReason: decision.stopReason });
          await vPage.close().catch(() => {});
          await vCtx.close().catch(() => {});
          return { verified: false, reason: 'not_confirmed', status: probe.status };
        }
        if (!probe.ok) {
          const notConfirmedErr = createError(
            ErrorCodes.CAPTCHA_NOT_CONFIRMED,
            `Défi disparu mais aucune page de résultats confirmée (HTTP ${probe.status ?? '?'}, ${probe.outcome}) — session non persistée.`,
            { url: checkUrl, status: probe.status, outcome: probe.outcome });
          this.emit('log', { level: 'warn', message: `[warmup] [${notConfirmedErr.code}] ${notConfirmedErr.message}` });
          this._logAccessDiag({ where: 'post_captcha', url: checkUrl, status: probe.status, outcome: probe.outcome, cloudfront: probe.cloudfront, captcha: probe.captcha, hasResults: probe.hasResults, adCards: probe.adCards, source: probe.source, decision: 'stop', persist: false, stopReason: 'not_confirmed' });
          await vPage.close().catch(() => {});
          await vCtx.close().catch(() => {});
          return { verified: false, reason: 'not_confirmed', status: probe.status };
        }
        confirmedOk = true;
      }
      // Persiste la session validée (remplacement ATOMIQUE de l'ancien fichier),
      // puis ne lève le marqueur de restriction QUE si la persistance a réussi.
      const persistRes = await this._persistValidatedSession(vCtx, 'post_captcha');
      if (persistRes.ok) this._clearSessionRestricted();
      else this.emit('log', { level: 'warn', message: '[warmup] Accès confirmé pour cette session, mais la session n\'a PAS pu être persistée durablement — le marqueur de restriction est conservé.' });
      this._logAccessDiag({ where: 'post_captcha', url: checkUrl, status: probe ? probe.status : latestHttpStatus, outcome: 'results_ok', adCards: postCards || (probe ? probe.adCards : 0), source: probe ? probe.source : 'browser', decision: 'validated', persist: persistRes.ok, stopReason: persistRes.ok ? null : 'session_persist_failed' });
      this.emit('log', { level: 'debug', message: `[warmup] Accès confirmé objectivement (HTTP ${probe ? probe.status : latestHttpStatus ?? '?'}${postCards > 0 ? `, ${postCards} carte(s) d'annonces` : ', page de résultats détectée'}) — persistance de la session.` });

      await vPage.close().catch(() => {});
      await vCtx.close().catch(() => {});
      this.emit('log', { level: 'info', message: '✅ CAPTCHA résolu et session persistée — reprise du scraping invisible.' });
      return { verified: true, reason: 'captcha_resolved' };
    } finally {
      await visibleBrowser.close().catch(() => {});
    }
  }

  // Détecte une page de résultats VIDE (HTTP 200 mais sans annonces) : soft-block
  // anti-bot, page d'erreur HTML, ou recherche réellement sans résultat. On
  // distingue les deux via des marqueurs d'erreur/blocklist. Sans ce contrôle,
  // un soft-block en 200 était traité comme une page réussie (aucune alerte).
  async _looksLikeEmptyResults(page) {
    try {
      const info = await page.evaluate(() => {
        const text = (document.title + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
        // Sélecteurs STRICTS des cartes d'annonces Leboncoin (pas de sous-chaîne
        // `[data-test-id*="ad"]` qui compterait `header`/`badge` → faux « page
        // de résultats » sur une page de blocage).
        const count = document.querySelectorAll('a[href*="/ad/"], [data-test-id="ad"], [data-test-id="adcard"], [data-test-id="ad-card"], [data-test-id="aditem"], [data-test-id="ad-item"], [data-test-id="listing"], [data-test-id="listing-card"]').length;
        const errorMarkers = ['erreur', 'error', 'indisponible', 'unavailable', 'réessayez', 'service indisponible', 'try again', 'something went wrong', 'request blocked', 'could not be satisfied', 'generated by cloudfront'];
        const matched = errorMarkers.find((m) => text.includes(m)) || null;
        return { count, matched, text };
      });
      if (info.count > 0) return { empty: false };
      // Aucune carte : soit blocage (marqueur d'erreur OU page CloudFront/restriction),
      // soit recherche réellement vide. La page CloudFront « Request blocked » et la
      // page « Accès temporairement restreint » sont servies même en HTTP 200 → sans
      // ce contrôle elles passeraient pour un succès (ou une simple recherche vide).
      const cf = detectCloudFrontBlock(info.text);
      if (cf.blocked) {
        return { empty: true, blocked: true, marker: cf.marker, provider: cf.provider, kind: cf.provider === 'cloudfront' ? 'cloudfront' : 'anti-bot' };
      }
      const restriction = detectRestrictionPage(info.text);
      if (restriction.restricted) {
        return { empty: true, blocked: true, marker: restriction.marker, provider: 'leboncoin', kind: 'restricted' };
      }
      return { empty: true, blocked: !!info.matched, marker: info.matched };
    } catch (e) {
      this.emit('log', { level: 'debug', message: `[capture] Détection page vide impossible : ${e.message}.` });
      return { empty: false };
    }
  }

  async capture({ searchUrl, maxPages = 1, outputHarPath, resumeFrom = null }) {
    if (!searchUrl) throw new Error("L'URL de recherche est requise.");
    // Anti-SSRF : l'URL de recherche (entrée utilisateur) doit viser un domaine
    // Leboncoin légitime et non une IP privée/locale. Contrôle AVANT le
    // lancement de Chromium (aucune connexion réseau n'est tentée si invalide).
    const destCheck = isSafeFetchDestination(searchUrl, LEBONCOIN_SOURCE_HOSTS);
    if (!destCheck.safe) {
      throw new Error(`URL de recherche refusée (${destCheck.reason}). Utilisez une URL de recherche leboncoin.fr.`);
    }
    const targetDir = path.dirname(outputHarPath);
    fs.mkdirSync(targetDir, { recursive: true });
    const statePath = path.join(targetDir, 'session-state.json');

    // Reprise incrémentale : si `resumeFrom` est fourni (ou détecté via
    // capture-progress.json), on redémarre à cette page au lieu de 1. Les pages
    // déjà capturées restent dans le HAR précédent (fusionné par le main process).
    let startPage = 1;
    if (typeof resumeFrom === 'number' && resumeFrom > 1) {
      startPage = Math.min(resumeFrom, maxPages);
      this.emit('log', { level: 'info', message: `⏩ Reprise incrémentale demandée : capture à partir de la page ${startPage} (pages 1-${startPage - 1} déjà capturées).` });
    } else {
      // Auto-reprise : si un HAR partiel et un état de progression existent dans
      // ce job (nouvelle tentative sur le même dossier), on reprend après la
      // dernière page réussie au lieu de tout re-capturer.
      const prev = readProgress(targetDir);
      if (prev && typeof prev.lastPageOk === 'number' && prev.lastPageOk >= 1 && fs.existsSync(outputHarPath)) {
        const resumeAt = Math.min(prev.lastPageOk + 1, maxPages);
        if (resumeAt > 1) {
          startPage = resumeAt;
          this.emit('log', { level: 'info', message: `⏩ Reprise automatique détectée (${prev.lastPageOk} page(s) déjà OK) — capture à partir de la page ${startPage}.` });
        }
      }
    }

    this.emit('log', { level: 'info', message: `🚀 Initialisation de la capture HAR (${maxPages} page(s))...` });
    this.emit('log', { level: 'debug', message: `[capture] searchUrl=${searchUrl} | maxPages=${maxPages} | outputHarPath=${outputHarPath} | proxy=${this.proxyUrl || 'aucun'} | headless=${this.headless}` });

    // En reprise (startPage>1), Playwright écrirait dans outputHarPath et
    // écraserait le HAR des pages déjà capturées. On écrit donc dans un HAR
    // séparé, fusionné avec l'ancien à la fin.
    const resumeHarPath = path.join(targetDir, 'capture-resume.har');
    const activeHarPath = startPage > 1 ? resumeHarPath : outputHarPath;
    const isResume = startPage > 1;
    // HAR dédié à la reprise après CAPTCHA. Playwright ÉCRASE le fichier d'un
    // `recordHar` réutilisé par un nouveau contexte (vérifié empiriquement) : si
    // la reprise écrivait dans `activeHarPath`, toutes les pages déjà capturées
    // avant le blocage seraient perdues. On écrit donc dans un fichier séparé,
    // fusionné à la fin (comme la reprise incrémentale).
    const retryHarPath = path.join(targetDir, 'capture-retry.har');
    let usedRetryHar = false;

    let browser;
    let context;
    let page;

    try {
      browser = await chromium.launch(this._launchOptions(this.headless));
      this.emit('log', { level: 'debug', message: `[capture] Chromium lancé (headless=${this.headless} pour la capture — suit le réglage d'affichage).` });

      let globalSessionSaved = false;

      // Pré-check captcha + bascule visible si nécessaire (avant la boucle HAR).
      const warmup = await this._warmupSession(browser, buildPageUrl(searchUrl, 1));
      // Si le pré-check n'a PAS pu valider l'accès (CAPTCHA non résolu, timeout,
      // 2e CAPTCHA, page de refus CloudFront), on n'entame PAS la capture : c'était
      // une boucle de fenêtres CAPTCHA stérile. Arrêt propre ; l'erreur porte un
      // code structuré (blockCode) pour que le main process rapporte l'état exact
      // (accès non vérifié / refusé) au lieu d'un échec générique.
      if (warmup && warmup.verified === false) {
        const stopCode = warmup.blockCode
          || (warmup.reason === 'cancelled' ? ErrorCodes.CAPTCHA_UNRESOLVED : ErrorCodes.ACCESS_UNVERIFIED);
        this.emit('log', { level: 'warn', message: `[capture] Pré-check non validé (${warmup.reason}) — capture annulée (aucune fenêtre CAPTCHA en boucle).` });
        await browser.close().catch(() => {});
        throw Object.assign(
          new Error(`Session non validée (${warmup.reason}) : capture annulée pour éviter une boucle de CAPTCHA.`),
          { code: stopCode, accessUnverified: stopCode === ErrorCodes.ACCESS_UNVERIFIED || stopCode === ErrorCodes.ACCESS_RESTRICTED });
      }
      if (this.isCancelled) {
        this.emit('log', { level: 'debug', message: '[capture] Capture annulée après pré-check (isCancelled=true).' });
        await browser.close().catch(() => {});
        return outputHarPath;
      }

      // 🛑 FIX : délai entre warmup et capture. Les logs montraient que le
      // warmup (HTTP 200) et la capture (HTTP 403) arrivaient dans la même
      // seconde → Leboncoin rate-limitait la requête trop rapide. Un délai de
      // 2s laisse le temps au rate-limiter de Leboncoin de se réinitialiser.
      this.emit('log', { level: 'debug', message: '[capture] Délai de sécurité (2s) après warmup pour éviter le rate-limit Leboncoin.' });
      await sleep(2000);

      const contextOptions = this._baseContextOptions({
        recordHar: {
          path: activeHarPath,
          mode: 'full',
          urlFilter: /recherche|api|items/i,
        },
      });

      const reusableCaptureSession = this._reusableSessionPath();
      if (reusableCaptureSession) {
        contextOptions.storageState = reusableCaptureSession;
        this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour la capture.' });
      } else {
        this.emit('log', { level: 'warn', message: '[capture] Aucune session globale réutilisable pour la capture — risque de blocage captcha plus élevé.' });
      }

      ({ ctx: context, p: page } = await this._newStealthContext(browser, contextOptions));
      this.emit('log', { level: 'debug', message: '[capture] Contexte HAR créé (filtrage URL: recherche|api|items).' });

      // Signatures des pages déjà vues : détecte une boucle de pagination
      // (Leboncoin peut renvoyer la MÊME page pour page=2, page=3…). Sans ce
      // garde-fou, on consommait N navigations identiques (durée de session et
      // risque de rate-limit multipliés sans aucun gain de données).
      const seenPageSignatures = new Set();
      // Erreur fatale différée : un `throw` direct dans le try par-page serait
      // avalé par son `catch (gotoErr)`. On mémorise puis on relance après la boucle.
      let fatalError = null;

      for (let pageNum = startPage; pageNum <= maxPages; pageNum++) {
        if (this.isCancelled) {
          this.emit('log', { level: 'debug', message: `[capture] Boucle de capture interrompue à la page ${pageNum} (annulation).` });
          break;
        }

        // Recyclage toutes les 3 pages pour la RAM
        if (pageNum > 1 && pageNum % 3 === 0) {
          this.emit('log', { level: 'debug', message: '🔄 Purge mémoire Chromium...' });
          await page.close().catch(() => {});
          await sleep(500);
          page = await context.newPage();
        }

        const targetUrl = buildPageUrl(searchUrl, pageNum);
        this.emit('progress', { currentPage: pageNum, totalPages: maxPages, percent: Math.round((pageNum / maxPages) * 100), status: `Navigation page ${pageNum}/${maxPages}...` });
        this.emit('log', { level: 'info', message: `[Page ${pageNum}/${maxPages}] Navigation vers ${targetUrl}` });

        try {
          this.journal.recordNavigation();
          const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const httpStatus = resp ? resp.status() : '?';
          this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Page chargée — HTTP ${httpStatus}.` });

          // Sauvegarde la session globale dès la 1ère page réussie (HTTP < 400).
          // On NE la réécrit PAS ensuite : les pages suivantes peuvent être 403
          // (anti-bot) et empoisonneraient la session avec des cookies de blocage.
          // Écriture ATOMIQUE (correction F2) : un ancien fichier est REMPLACÉ,
          // jamais laissé partiellement écrit.
          if (typeof httpStatus === 'number' && httpStatus < 400 && !globalSessionSaved) {
            const capturePersist = await this._persistValidatedSession(context, 'capture');
            if (capturePersist.ok) {
              globalSessionSaved = true;
              this.emit('log', { level: 'debug', message: `[capture] Session globale sauvegardée après page ${pageNum} (HTTP ${httpStatus}).` });
            } else {
              this.emit('log', { level: 'warn', message: `[capture] Sauvegarde session globale impossible après page ${pageNum} : ${capturePersist.error}` });
            }
          }

          // Best-effort networkidle avant la détection CAPTCHA : les iframes
          // Arkose/Cloudflare chargent après domcontentloaded. Sans ce délai,
          // on peut rater un CAPTCHA qui n'est pas encore rendu.
          await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

          // 🤖 DÉTECTION DE BLOCAGE : CAPTCHA (texte/iframe/URL), page de refus
          // CloudFront (même en HTTP 200) OU HTTP >= 400. Un 403 sans texte
          // CAPTCHA est un blocage silencieux : on arrête immédiatement au lieu
          // de gaspiller des requêtes sur les pages suivantes.
          const accessBlock = await this._detectAccessBlock(page, typeof httpStatus === 'number' ? httpStatus : null);
          if (accessBlock.blocked) {
            const is429 = httpStatus === 429 || accessBlock.kind === 'rate_limited';
            const blockCode = accessBlock.kind === 'cloudfront'
              ? ErrorCodes.HTTP_ACCESS_REFUSED
              : accessBlock.kind === 'captcha'
                ? ErrorCodes.CAPTCHA_DETECTED
                : is429 ? ErrorCodes.HTTP_429
                : httpStatus === 403 ? ErrorCodes.HTTP_403
                : ErrorCodes.HTTP_UNKNOWN;
            const reason = accessBlock.reason || `HTTP ${httpStatus}`;
            const blockErr = createError(blockCode, `BLOCAGE DÉTECTÉ (${reason}) — tentative de résolution interactive`, { page: pageNum, httpStatus, reason, kind: accessBlock.kind });
            this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] [${blockErr.code}] BLOCAGE DÉTECTÉ (${reason}) — tentative de résolution interactive...` });
            this.journal.recordBlock(targetUrl, typeof httpStatus === 'number' ? httpStatus : null);

            // 🛑 Page « Accès temporairement restreint » : refus DURABLE, aucun
            // défi humain à résoudre. Ouvrir une fenêtre CAPTCHA serait stérile et
            // trompeur. On arrête proprement ; les pages déjà capturées restent
            // dans le HAR (elles seront conservées).
            if (accessBlock.kind === 'restricted') {
              this.emit('log', { level: 'warn', message: `⛔ [Page ${pageNum}] [${ErrorCodes.ACCESS_RESTRICTED}] Accès restreint par le site (${reason}) — arrêt de la capture, données déjà acquises conservées.` });
              this._markSessionRestricted('capture_restricted');
              this._logAccessDiag({ where: `capture_page_${pageNum}`, url: targetUrl, status: typeof httpStatus === 'number' ? httpStatus : null, outcome: 'access_restricted', restricted: true, restrictedMarker: accessBlock.marker, decision: 'stop', persist: false, stopReason: 'access_restricted' });
              this.journal.recordPageResult(false);
              fatalError = Object.assign(
                new Error(`Accès restreint par le site (${reason}) : arrêt de la capture.`),
                { code: ErrorCodes.ACCESS_RESTRICTED, accessUnverified: true });
              break;
            }

            // Au lieu d'abandonner, on tente une résolution interactive :
            // ferme le contexte HAR, ouvre une fenêtre visible, puis relance
            // la capture depuis la page bloquée.
            await page.close().catch(() => {});
            await context.close().catch(() => {});
            context = null;
            page = null;
            await browser.close().catch(() => {});
            browser = null;

            // _warmupSession ouvre un navigateur visible, attend la résolution,
            // persiste la session, puis ferme. Si résolu, on relance la capture.
            this.emit('log', { level: 'info', message: '[capture] Ouverture fenêtre de résolution CAPTCHA (pendant la capture)...' });
            const retryBrowser = await chromium.launch(this._launchOptions(this.headless));
            let retryWarmup = null;
            try {
              retryWarmup = await this._warmupSession(retryBrowser, buildPageUrl(searchUrl, pageNum));
            } finally {
              await retryBrowser.close().catch(() => {});
            }

            if (this.isCancelled) {
              this.emit('log', { level: 'debug', message: '[capture] Capture annulée pendant résolution CAPTCHA.' });
              return outputHarPath;
            }

            // Si la résolution interactive n'a pas validé l'accès, on ARRÊTE :
            // relancer la capture relancerait une fenêtre CAPTCHA en boucle.
            if (retryWarmup && retryWarmup.verified === false) {
              const stopCode = retryWarmup.blockCode
                || (retryWarmup.reason === 'cancelled' ? ErrorCodes.CAPTCHA_UNRESOLVED : ErrorCodes.ACCESS_UNVERIFIED);
              this.emit('log', { level: 'warn', message: `[capture] Résolution non validée (${retryWarmup.reason}) — arrêt de la capture (pas de boucle CAPTCHA).` });
              fatalError = Object.assign(
                new Error(`Accès non validé (${retryWarmup.reason}) : arrêt de la capture.`),
                { code: stopCode, accessUnverified: stopCode === ErrorCodes.ACCESS_UNVERIFIED || stopCode === ErrorCodes.ACCESS_RESTRICTED });
              break;
            }

            // Relance le navigateur et le contexte HAR, puis reprend à la page bloquée.
            browser = await chromium.launch(this._launchOptions(this.headless));
            // HAR séparé : réutiliser activeHarPath écraserait les pages déjà
            // capturées avant le blocage (Playwright tronque le fichier réutilisé).
            usedRetryHar = true;
            const retryCtxOpts = this._baseContextOptions({
              recordHar: { path: retryHarPath, mode: 'full', urlFilter: /recherche|api|items/i },
            });
            const reusableRetrySession = this._reusableSessionPath();
            if (reusableRetrySession) {
              retryCtxOpts.storageState = reusableRetrySession;
              this.emit('log', { level: 'info', message: '🔑 Session validée chargée pour reprise de capture.' });
            }
            ({ ctx: context, p: page } = await this._newStealthContext(browser, retryCtxOpts));
            this.emit('log', { level: 'info', message: `[capture] Reprise après résolution CAPTCHA — page ${pageNum}.` });
            // Ne pas retry cette page dans la boucle : on la capture à nouveau.
            this.journal.recordNavigation();
            const retryResp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch((e) => {
              this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Reprise échouée : ${e.message}` });
            });
            const retryStatus = retryResp ? retryResp.status() : '?';
            this.emit('log', { level: 'debug', message: `[Page ${pageNum}] Reprise — HTTP ${retryStatus}.` });
            this.journal.recordPageResult(typeof retryStatus === 'number' && retryStatus < 400);
          } else if (accessBlock.evaluationFailed) {
            // Contenu non évaluable (contexte/page fermé, DOM indisponible) : ce
            // n'est PAS une preuve que la page est une page de résultats valide.
            // On ne la compte donc PAS comme réussie (l'ancien comportement la
            // faisait passer pour « non bloquée », ce qui masquait un échec réel).
            this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Contenu non évaluable (état INDÉTERMINÉ) — page NON comptée comme réussie.` });
            this.journal.recordPageResult(false);
          } else {
            // Page non bloquée : détection d'une page de résultats VIDE (HTTP 200
            // sans annonces → soft-block/erreur HTML) et d'une boucle de pagination.
            const emptyCheck = await this._looksLikeEmptyResults(page);
            if (emptyCheck.empty) {
              if (emptyCheck.blocked) {
                const emptyCode = emptyCheck.kind === 'cloudfront' ? ErrorCodes.HTTP_ACCESS_REFUSED
                  : emptyCheck.kind === 'restricted' ? ErrorCodes.ACCESS_RESTRICTED
                  : ErrorCodes.CAPTCHA_DETECTED;
                const emptyErr = createError(emptyCode, `Page de résultats vide (marqueur « ${emptyCheck.marker} ») — blocage probable`, { page: pageNum, httpStatus, kind: emptyCheck.kind });
                this.emit('log', { level: 'warn', message: `⚠️ [Page ${pageNum}] [${emptyErr.code}] Page 200 vide (marqueur « ${emptyCheck.marker} ») — blocage probable, arrêt préventif.` });
                this.journal.recordPageResult(false);
                // Page « Accès temporairement restreint » : refus durable → on
                // remonte un état explicite (les pages déjà capturées restent).
                if (emptyCheck.kind === 'restricted') {
                  this._markSessionRestricted('capture_empty_restricted');
                  this._logAccessDiag({ where: `capture_page_${pageNum}`, url: targetUrl, status: typeof httpStatus === 'number' ? httpStatus : null, outcome: 'access_restricted', restricted: true, restrictedMarker: emptyCheck.marker, adCards: 0, source: 'browser', decision: 'stop', persist: false, stopReason: 'access_restricted' });
                  fatalError = Object.assign(
                    new Error(`Accès restreint par le site (marqueur « ${emptyCheck.marker} ») : arrêt de la capture.`),
                    { code: ErrorCodes.ACCESS_RESTRICTED, accessUnverified: true });
                }
                break;
              }
              this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Aucune annonce détectée sur cette page (recherche sans résultat ou fin de pagination).` });
            }

            // Boucle de pagination : signature = nombre d'annonces + 1er id/titre.
            try {
              const sig = await page.evaluate(() => {
                const cards = document.querySelectorAll('a[href*="/ad/"]');
                const first = cards[0] ? cards[0].getAttribute('href') : '';
                return `${cards.length}|${first}`;
              });
              if (seenPageSignatures.has(sig)) {
                this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Contenu identique à une page déjà vue (boucle de pagination) — arrêt pour éviter des requêtes dupliquées.` });
                this.journal.recordPageResult(false);
                break;
              }
              seenPageSignatures.add(sig);
            } catch { /* signature best-effort */ }

            this.journal.recordPageResult(true);
            // Reprise incrémentale : mémorise la dernière page réussie. En cas de
            // blocage ultérieur, le main process peut reprendre à lastPageOk+1 sans
            // re-capturer les pages déjà valides.
            writeProgress(targetDir, {
              searchUrl,
              pagesRequested: maxPages,
              lastPageOk: pageNum,
              pagesOk: this.journal.pagesOk,
            });
          }
        } catch (gotoErr) {
          this.journal.recordError();
          this.emit('log', { level: 'warn', message: `[Page ${pageNum}] Avertissement : ${gotoErr.message}` });
          this.emit('log', { level: 'debug', message: `[capture] Détail erreur page ${pageNum} : ${describeError(gotoErr)}` });
        }

        if (pageNum < maxPages) {
          const minDelay = this.minPageDelayMs;
          const maxDelay = Math.max(this.maxPageDelayMs, minDelay);
          await sleep(minDelay + Math.random() * (maxDelay - minDelay));
        }
      }

      // Une erreur fatale différée (résolution CAPTCHA non validée) doit
      // interrompre la capture AVANT la finalisation/sauvegarde de session.
      if (fatalError) throw fatalError;

      this.emit('log', { level: 'info', message: 'Finalisation et sauvegarde de la session...' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Session locale (par-job) : toujours sauvegardée pour le pipeline d'enrichissement.
      // La session globale (GLOBAL_SESSION_PATH) a déjà été sauvegardée après la 1ère page
      // réussie ci-dessus — on ne l'écrase PAS ici pour éviter de la corrompre avec d'éventuels
      // cookies anti-bot accumulés sur les pages suivantes (403).
      await context.storageState({ path: statePath });

      await context.close();
      await browser.close();
      browser = null;
      this.emit('log', { level: 'info', message: `✅ Session synchronisée.` });

      // Bilan réseau structuré (compteurs objectifs, sans heuristique de texte).
      const j = this.journal.snapshot();
      this.emit('log', { level: 'info', message: `[NET_JOURNAL] navigations=${j.navigations} pages_ok=${j.pagesOk} pages_failed=${j.pagesFailed} blocked=${j.blockedRequests} errors=${j.otherErrors}` });
      this.emit('log', { level: 'debug', message: `[capture] Journal réseau : ${JSON.stringify(j)}` });

      // Reprise : fusionne le HAR de reprise (pages startPage..N) avec le HAR
      // précédent (pages 1..startPage-1) → outputHarPath contient toutes les pages.
      if (isResume) {
        try {
          const merged = mergeHarFiles([outputHarPath, resumeHarPath], outputHarPath);
          this.emit('log', { level: 'info', message: `🔗 HAR de reprise fusionné : ${merged.sources} source(s), ${merged.entries} entrée(s).` });
        } catch (e) {
          this.emit('log', { level: 'warn', message: `[capture] Fusion HAR impossible : ${e.message} — le HAR de reprise reste séparé (${resumeHarPath}).` });
        }
      }

      // Fusionne le HAR de reprise CAPTCHA (pages capturées APRÈS résolution)
      // avec le HAR principal (pages capturées AVANT le blocage). Sans cette
      // fusion, la reprise écrasait/écartait les pages déjà collectées.
      if (usedRetryHar) {
        try {
          if (fs.existsSync(retryHarPath)) {
            const merged = mergeHarFiles([outputHarPath, retryHarPath], outputHarPath);
            this.emit('log', { level: 'info', message: `🔗 HAR de reprise CAPTCHA fusionné : ${merged.sources} source(s), ${merged.entries} entrée(s).` });
          }
        } catch (e) {
          this.emit('log', { level: 'warn', message: `[capture] Fusion HAR de reprise CAPTCHA impossible : ${e.message} — le HAR reste séparé (${retryHarPath}).` });
        }
      }

      // Diagnostic final : taille du HAR généré
      if (fs.existsSync(outputHarPath)) {
        const harSize = fs.statSync(outputHarPath).size;
        this.emit('log', { level: 'debug', message: `[capture] HAR généré : ${outputHarPath} (${formatBytes(harSize)}).` });
      } else {
        this.emit('log', { level: 'warn', message: `[capture] ⚠️ Le fichier HAR n'a pas été créé : ${outputHarPath}` });
      }

      return outputHarPath;
    } catch (err) {
      this.emit('log', { level: 'error', message: `❌ Erreur : ${err.message}` });
      this.emit('log', { level: 'debug', message: `[capture] Détail erreur fatale : ${describeError(err)}` });
      throw err;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
}

module.exports = { HarCapturer };