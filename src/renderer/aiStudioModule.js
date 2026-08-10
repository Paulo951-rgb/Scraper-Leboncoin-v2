'use strict';

/**
 * Module "Navigateur IA Studio + Analyse de fichiers".
 *
 * Logique renderer isolée du reste de app.js pour garder le module indépendant
 * et lisible. Exposé sur window.aiStudioModule, initialisé au chargement.
 *
 * Le module ne contient PLUS de prompts statiques : la génération de prompt
 * est déléguée à Gemini via l'IPC 'prompt:generate' (service promptGenerator).
 * Le renderer se contente de collecter le contexte (domaine, objectif,
 * variables) et d'appeler l'IA, puis d'afficher / copier le prompt généré.
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/';

const DOMAINS = [
  { id: 'hardware', label: '🖥️ PC / Hardware', defaults: { searchContext: 'PC fixes', productFamily: 'PC fixes', component: 'SSD', capacity: '500 Go', capacity2: '1 To', dealThreshold: '30 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'gpu', label: '🎮 Cartes graphiques', defaults: { searchContext: 'cartes graphiques', productFamily: 'cartes graphiques', component: 'GPU', capacity: '8 Go', capacity2: '12 Go', dealThreshold: '150 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'smartphone', label: '📱 Smartphones', defaults: { searchContext: 'smartphones', productFamily: 'smartphones', component: 'modèle', capacity: '128 Go', capacity2: '256 Go', dealThreshold: '150 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'books', label: '📚 Livres', defaults: { searchContext: 'livres', productFamily: 'livres', component: 'collection', capacity: 'Folio Junior', capacity2: 'Livre de Poche', dealThreshold: '5 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'custom', label: '✏️ Personnalisé', defaults: { searchContext: 'produits', productFamily: 'produits', component: 'produit', capacity: '—', capacity2: '—', dealThreshold: '—', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
];

const VAR_FIELDS = ['searchContext', 'productFamily', 'component', 'capacity', 'capacity2', 'dealThreshold', 'topN', 'flipN', 'compN', 'nuggetN', 'avoidN'];

const $ = (id) => document.getElementById(id);

const AiStudioModule = {
  init() {
    const els = [
      'aistudioDomainSelect', 'aistudioObjective', 'aistudioCustomHints',
      'aistudioOllamaUrl', 'aistudioOllamaModel', 'aistudioOllamaTestBtn', 'aistudioOllamaStatus',
      'aistudioGenerateBtn', 'aistudioCopyBtn', 'aistudioGenStatus',
      'aistudioPromptOutput',
      'aistudioOpenJobsBtn',
      'aistudioWebview', 'aistudioWebviewLoading',
      'aistudioBackBtn', 'aistudioFwdBtn', 'aistudioReloadBtn', 'aistudioHomeBtn',
      'aistudioLoginBtn',
      'aistudioUrlBar', 'aistudioOpenExternalBtn',
    ];
    const e = {};
    let missing = false;
    for (const id of els) { e[id] = $(id); if (!e[id]) { console.warn('[AI Studio] élément manquant :', id); missing = true; } }
    if (missing) return;

    this.el = e;
    this.populateDomainSelect();
    this.applyDomainDefaults(DOMAINS[0].id);
    this.bindActions(e);
    this.bindBrowser(e);
  },

  populateDomainSelect() {
    const sel = this.el.aistudioDomainSelect;
    sel.innerHTML = '';
    for (const d of DOMAINS) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.label;
      sel.appendChild(o);
    }
  },

  applyDomainDefaults(domainId) {
    const d = DOMAINS.find((x) => x.id === domainId) || DOMAINS[0];
    for (const k of VAR_FIELDS) {
      const input = $('var' + k.charAt(0).toUpperCase() + k.slice(1));
      if (input) input.value = d.defaults[k] ?? '';
    }
  },

  collectVars() {
    const vars = {};
    for (const k of VAR_FIELDS) {
      const input = $('var' + k.charAt(0).toUpperCase() + k.slice(1));
      if (input) vars[k] = input.value;
    }
    return vars;
  },

  setGenStatus(msg, isError) {
    const el = this.el.aistudioGenStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : '';
  },

  bindActions(e) {
    e.aistudioDomainSelect.addEventListener('change', (ev) => this.applyDomainDefaults(ev.target.value));
    e.aistudioOpenJobsBtn.addEventListener('click', () => {
      if (window.api && window.api.openFolder) {
        window.api.openFolder(null);
      }
    });
    e.aistudioGenerateBtn.addEventListener('click', () => this.generatePrompt());
    e.aistudioCopyBtn.addEventListener('click', () => this.copyPrompt());
    e.aistudioOllamaTestBtn.addEventListener('click', () => this.testOllama());
  },

  setOllamaStatus(msg, isError, ok) {
    const el = this.el.aistudioOllamaStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : (ok ? '#7ec97e' : '');
  },

  async testOllama() {
    const url = (this.el.aistudioOllamaUrl.value || '').trim() || 'http://127.0.0.1:11434';
    const sel = this.el.aistudioOllamaModel;
    const btn = this.el.aistudioOllamaTestBtn;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';
    this.setOllamaStatus('Connexion à Ollama…');
    try {
      const res = await window.api.listOllamaModels({ ollamaUrl: url });
      if (res && res.ok && res.models && res.models.length) {
        // Remplit le select avec les modèles réellement installés.
        sel.innerHTML = '';
        for (const m of res.models) {
          const o = document.createElement('option');
          o.value = m; o.textContent = m;
          sel.appendChild(o);
        }
        this.setOllamaStatus(`✅ Ollama OK — ${res.models.length} modèle(s) : ${res.models.join(', ')}`, false, true);
      } else {
        this.setOllamaStatus(`❌ ${(res && res.message) || 'Aucun modèle installé.'} Lancez « ollama pull llama3 » et démarrez Ollama.`, true);
      }
    } catch (err) {
      this.setOllamaStatus('❌ Ollama injoignable : ' + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  },

  async generatePrompt() {
    const domainSel = this.el.aistudioDomainSelect;
    const domainObj = DOMAINS.find((d) => d.id === domainSel.value) || DOMAINS[0];
    const objective = (this.el.aistudioObjective.value || '').trim()
      || 'Trouve les meilleures affaires et opportunités d\'achat-revente, classe par score et marge nette, détecte les arnaques.';
    const customHints = (this.el.aistudioCustomHints.value || '').trim();
    const vars = this.collectVars();
    const ollamaUrl = (this.el.aistudioOllamaUrl.value || '').trim() || 'http://127.0.0.1:11434';
    const ollamaModel = this.el.aistudioOllamaModel.value || 'llama3';

    const btn = this.el.aistudioGenerateBtn;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Génération…';
    this.setGenStatus('Appel à Ollama (' + ollamaModel + ')…');

    try {
      // Construit les classements et la fourchette de prix à partir des vars du domaine.
      const rankings = ['Meilleures affaires (achat-revente)', 'Pépites sous-évaluées', 'Lots / composants récupérables', 'Produits à éviter'];
      if (vars.flipN) rankings.push(`Top ${vars.flipN} achat-revente`);
      if (vars.compN) rankings.push(`Top ${vars.compN} composants`);
      if (vars.nuggetN) rankings.push(`Top ${vars.nuggetN} pépites`);
      if (vars.avoidN) rankings.push(`Top ${vars.avoidN} à éviter`);
      const topN = parseInt(vars.topN, 10) || 50;
      let priceRange = null;
      const thresholdStr = String(vars.dealThreshold || '').trim();
      if (thresholdStr && thresholdStr !== '—') {
        const m = thresholdStr.match(/(\d+)/);
        if (m) priceRange = { min: 0, max: parseInt(m[1], 10) * 100 };
      }
      const res = await window.api.generatePrompt({
        domain: domainObj.label,
        objective,
        customHints,
        vars,
        ollamaUrl,
        ollamaModel,
        priceRange,
        topN,
        rankings,
      });
      const prompt = (res && res.prompt) || '';
      if (!prompt) throw new Error('Réponse vide.');
      this.el.aistudioPromptOutput.value = prompt;
      this.setGenStatus('✅ Prompt généré par ' + ollamaModel + ' (local).');
    } catch (err) {
      console.error('[AI Studio] génération échouée :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  },

  async copyPrompt() {
    let text = this.el.aistudioPromptOutput.value;
    if (!text) { this.setGenStatus('Générez d\'abord un prompt.', true); return; }
    try {
      await navigator.clipboard.writeText(text);
      const btn = this.el.aistudioCopyBtn;
      const orig = btn.textContent;
      btn.textContent = '✅ Copié !';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (err) {
      console.error('[AI Studio] copie échouée :', err);
      this.el.aistudioPromptOutput.select();
      document.execCommand('copy');
    }
  },

  bindBrowser(e) {
    const wv = e.aistudioWebview;
    const loading = e.aistudioWebviewLoading;

    // User-Agent Chrome réel (sans le mot "Electron") : AI Studio détecte
    // l'UA Electron et peut rendre en mode dégradé/blanchi. On spoofe un
    // Chrome standard pour qu'AI Studio s'affiche normalement.
    const CHROME_UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let uaForced = false;
    const forceUA = () => {
      if (uaForced) return;
      try { wv.setUserAgent(CHROME_UA); uaForced = true; } catch (_) {}
    };

    const updateUrl = (url) => {
      if (url) e.aistudioUrlBar.value = url;
    };

    if (wv && wv.addEventListener) {
      // Masquer l'indicateur après un délai de sécurité même si
      // did-stop-loading ne se déclenche pas (SPA AI Studio = chargement
      // en continu). On ne JAMAIS masquer avec un overlay blanc.
      let hideTimer = null;
      const scheduleHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => loading.classList.add('hidden'), 2500);
      };

      wv.addEventListener('did-start-loading', () => {
        forceUA();
        loading.classList.remove('hidden');
        scheduleHide();
      });
      wv.addEventListener('did-stop-loading', () => {
        loading.classList.add('hidden');
        updateUrl(wv.getURL ? wv.getURL() : null);
      });
      wv.addEventListener('did-finish-load', () => { loading.classList.add('hidden'); scheduleHide(); });
      wv.addEventListener('did-navigate', (ev) => { forceUA(); updateUrl(ev && ev.url); scheduleHide(); });
      wv.addEventListener('did-navigate-in-page', (ev) => { updateUrl(ev && ev.url); scheduleHide(); });
      wv.addEventListener('did-fail-load', (ev) => {
        loading.classList.add('hidden');
        if (ev && ev.errorCode && ev.errorCode !== -3) {
          console.warn('[AI Studio] chargement échoué :', ev.errorCode, ev.errorDescription);
        }
      });
      wv.addEventListener('dom-ready', () => { forceUA(); scheduleHide(); });

      // Tentative immédiate (au cas où dom-ready serait déjà passé).
      forceUA();
    }

    e.aistudioBackBtn.addEventListener('click', () => { try { wv.goBack(); } catch (_) {} });
    e.aistudioFwdBtn.addEventListener('click', () => { try { wv.goForward(); } catch (_) {} });
    e.aistudioReloadBtn.addEventListener('click', () => { try { wv.reload(); } catch (_) {} });
    e.aistudioHomeBtn.addEventListener('click', () => { try { wv.loadURL(AI_STUDIO_URL); } catch (_) {} });

    // Le <webview> est bloqué par Google pour l'OAuth ("Ce navigateur ou cette
    // application ne sont peut-être pas sécurisés"). On ouvre une vraie
    // BrowserWindow (même partition persistante) pour se connecter ; la
    // session est ensuite partagée avec le <webview>.
    e.aistudioLoginBtn.addEventListener('click', () => {
      const url = (wv && wv.getURL ? wv.getURL() : AI_STUDIO_URL) || AI_STUDIO_URL;
      if (window.api && window.api.openAiStudioLogin) {
        window.api.openAiStudioLogin(url);
      } else if (window.api && window.api.openExternal) {
        window.api.openExternal(url);
      }
    });

    e.aistudioOpenExternalBtn.addEventListener('click', () => {
      const url = (wv && wv.getURL ? wv.getURL() : AI_STUDIO_URL) || AI_STUDIO_URL;
      if (window.api && window.api.openExternal) window.api.openExternal(url);
      else window.open(url, '_blank');
    });
  },
};

window.aiStudioModule = AiStudioModule;
document.addEventListener('DOMContentLoaded', () => {
  try { AiStudioModule.init(); } catch (err) { console.error('[AI Studio] init échoué :', err); }
});
