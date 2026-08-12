'use strict';

/**
 * Module "Navigateur IA Studio + Prompts préfaits à trous".
 *
 * Logique renderer isolée du reste de app.js pour garder le module indépendant
 * et lisible. Exposé sur window.aiStudioModule, initialisé au chargement.
 *
 * V3 : les prompts sont affichés directement sous forme de cartes indépendantes
 * (accordéon). Chaque carte contient un prompt complet à trous. L'utilisateur
 * remplit les champs directement dans la carte, puis copie le prompt assemblé
 * — ou copie le prompt avec les trous tels quels pour les remplir dans AI Studio.
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/';

const $ = (id) => document.getElementById(id);

const AiStudioModule = {
  /** Templates chargés depuis le main process via IPC. */
  templates: [],

  init() {
    const els = [
      'aistudioCardsContainer', 'aistudioGenStatus',
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
    this.bindActions(e);
    this.bindBrowser(e);
    this.loadTemplates();
  },

  /** Charge les templates depuis le main process via IPC. */
  async loadTemplates() {
    try {
      if (!window.api || !window.api.listPromptTemplates) {
        this.setGenStatus('Erreur : API prompts préfaits indisponible.', true);
        return;
      }
      const res = await window.api.listPromptTemplates();
      if (!res || !res.templates || res.templates.length === 0) {
        this.setGenStatus('Aucun prompt préfait disponible.', true);
        return;
      }
      this.templates = res.templates;
      this.renderCards();
    } catch (err) {
      console.error('[AI Studio] chargement templates échoué :', err);
      this.setGenStatus('Erreur chargement prompts : ' + (err.message || err), true);
    }
  },

  /**
   * Génère les cartes de prompts. Chaque carte est un accordéon indépendant
   * (plusieurs cartes peuvent être ouvertes simultanément).
   */
  renderCards() {
    const container = this.el.aistudioCardsContainer;
    container.innerHTML = '';

    for (const tmpl of this.templates) {
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.dataset.tplId = tmpl.id;

      // En-tête (clic = expand/collapse)
      const header = document.createElement('div');
      header.className = 'prompt-card-header';
      const title = document.createElement('span');
      title.className = 'prompt-card-title';
      title.textContent = tmpl.title;
      const cat = document.createElement('span');
      cat.className = 'prompt-card-cat';
      cat.textContent = tmpl.category || '';
      const toggle = document.createElement('span');
      toggle.className = 'prompt-card-toggle';
      toggle.textContent = '▼';
      header.appendChild(title);
      if (tmpl.category) header.appendChild(cat);
      header.appendChild(toggle);

      // Description
      const desc = document.createElement('div');
      desc.className = 'prompt-card-desc';
      desc.textContent = tmpl.description || '';

      // Corps : champs + actions
      const body = document.createElement('div');
      body.className = 'prompt-card-body';

      const fields = document.createElement('div');
      fields.className = 'prompt-card-fields';
      for (const ph of tmpl.placeholders) {
        const field = document.createElement('div');
        field.className = 'prompt-card-field' + (ph.type === 'textarea' ? ' full' : '');
        const label = document.createElement('label');
        label.textContent = ph.label;
        label.htmlFor = 'pc_' + tmpl.id + '_' + ph.key;
        let input;
        if (ph.type === 'textarea') {
          input = document.createElement('textarea');
          input.rows = 2;
        } else if (ph.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
        } else {
          input = document.createElement('input');
          input.type = 'text';
        }
        input.id = 'pc_' + tmpl.id + '_' + ph.key;
        if (ph.placeholder) input.placeholder = ph.placeholder;
        if (ph.default !== undefined && ph.default !== null) input.value = ph.default;
        field.appendChild(label);
        field.appendChild(input);
        fields.appendChild(field);
      }

      const actions = document.createElement('div');
      actions.className = 'prompt-card-actions';
      const copyFilled = document.createElement('button');
      copyFilled.className = 'btn btn-primary';
      copyFilled.textContent = '📋 Copier le prompt rempli';
      copyFilled.addEventListener('click', () => this.copyFilledPrompt(tmpl));
      const copyRaw = document.createElement('button');
      copyRaw.className = 'btn btn-secondary';
      copyRaw.textContent = '📝 Copier avec les trous';
      copyRaw.addEventListener('click', () => this.copyRawPrompt(tmpl));
      actions.appendChild(copyFilled);
      actions.appendChild(copyRaw);

      body.appendChild(fields);
      body.appendChild(actions);

      card.appendChild(header);
      card.appendChild(desc);
      card.appendChild(body);

      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      container.appendChild(card);
    }
  },

  /**
   * Copie le prompt assemblé avec les valeurs des champs de la carte.
   */
  async copyFilledPrompt(tmpl) {
    const values = {};
    for (const ph of tmpl.placeholders) {
      const input = $('pc_' + tmpl.id + '_' + ph.key);
      if (input) values[ph.key] = input.value;
    }
    try {
      const res = await window.api.buildPrompt(tmpl.id, values);
      if (!res || res.error) throw new Error(res ? res.error : 'Erreur inconnue');
      if (!res.prompt) throw new Error('Prompt vide.');
      await this.copyToClipboard(res.prompt);
      this.flashCard(tmpl.id, '✅ Prompt rempli copié !');
    } catch (err) {
      console.error('[AI Studio] copie prompt rempli échouée :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
    }
  },

  /**
   * Copie le prompt brut avec les [TROUS] intacts, pour que l'utilisateur
   * les remplisse directement dans AI Studio.
   */
  async copyRawPrompt(tmpl) {
    const res = await window.api.buildPrompt(tmpl.id, {});
    // buildPrompt avec values={} utilise les défauts — on veut les trous.
    // On régénère le prompt brut en laissant les [PLACEHOLDERS] tels quels.
    let raw = tmpl.template;
    // buildPrompt remplace déjà par les défauts, donc on prend le template brut.
    // res.prompt contient le prompt avec défauts. On préfère les trous : on
    // récupère le template brut directement.
    const tmplObj = this.templates.find((t) => t.id === tmpl.id);
    if (tmplObj) raw = tmplObj.template;
    try {
      await this.copyToClipboard(raw);
      this.flashCard(tmpl.id, '✅ Prompt brut copié (avec trous) !');
    } catch (err) {
      console.error('[AI Studio] copie prompt brut échouée :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
    }
  },

  flashCard(tplId, msg) {
    const card = this.el.aistudioCardsContainer.querySelector(
      `.prompt-card[data-tpl-id="${tplId}"]`
    );
    if (!card) return;
    const statusEl = card.querySelector('.prompt-card-actions')?.nextSibling;
    // Affiche le feedback temporairement sous les boutons.
    let flash = card.querySelector('.prompt-card-flash');
    if (!flash) {
      flash = document.createElement('div');
      flash.className = 'prompt-card-flash';
      flash.style.cssText = 'text-align:center;font-size:0.78rem;color:#4ade80;margin-top:6px;';
      card.querySelector('.prompt-card-body').appendChild(flash);
    }
    flash.textContent = msg;
    setTimeout(() => { if (flash) flash.textContent = ''; }, 2000);
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Fallback : textarea temporaire
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  },

  setGenStatus(msg, isError) {
    const el = this.el.aistudioGenStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : '';
  },

  bindActions(e) {
    e.aistudioOpenJobsBtn.addEventListener('click', () => {
      if (window.api && window.api.openJobsFolder) {
        window.api.openJobsFolder();
      } else if (window.api && window.api.openFolder) {
        window.api.openFolder(null);
      }
    });
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

      forceUA();
    }

    e.aistudioBackBtn.addEventListener('click', () => { try { wv.goBack(); } catch (_) {} });
    e.aistudioFwdBtn.addEventListener('click', () => { try { wv.goForward(); } catch (_) {} });
    e.aistudioReloadBtn.addEventListener('click', () => { try { wv.reload(); } catch (_) {} });
    e.aistudioHomeBtn.addEventListener('click', () => { try { wv.loadURL(AI_STUDIO_URL); } catch (_) {} });

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

