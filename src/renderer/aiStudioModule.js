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
    // Les prompts préfaits sont chargés EN PREMIER et indépendamment du
    // navigateur intégré : si le <webview> AI Studio échoue à s'attacher, cela
    // ne doit JAMAIS empêcher les prompts de s'afficher (c'est la fonctionnalité
    // principale de l'onglet). On branche les actions puis le navigateur après.
    this.bindActions(e);
    this.loadTemplates();
    // bindBrowser est volontairement en dernier et isolé : une erreur de webview
    // ne bloque ni les prompts ni les actions.
    try {
      this.bindBrowser(e);
    } catch (err) {
      console.error('[AI Studio] navigateur intégré indisponible :', err);
      if (e.aistudioGenStatus) e.aistudioGenStatus.textContent = 'Navigateur IA Studio indisponible — les prompts restent utilisables.';
    }
  },

  /** Charge les templates depuis le main process via IPC. */
  async loadTemplates() {
    // État de chargement visible : si l'IPC échoue ou reste sans réponse,
    // l'utilisateur voit « Chargement… » au lieu d'un onglet vide (qui donnait
    // l'impression que les prompts étaient cassés).
    this.setGenStatus('⏳ Chargement des prompts…', false);
    try {
      if (!window.api || !window.api.listPromptTemplates) {
        this.setGenStatus('Erreur : API prompts préfaits indisponible.', true);
        this._showRetry();
        return;
      }
      const res = await window.api.listPromptTemplates();
      if (!res || !res.templates || res.templates.length === 0) {
        this.setGenStatus('Aucun prompt préfait disponible' + (res && res.error ? ' : ' + res.error : '') + '.', true);
        this._showRetry();
        return;
      }
      this.templates = res.templates;
      this.renderCards();

      // Charge aussi les prompts IA internes (adAnalyzer, marketValueAnalyzer)
      this.loadInternalPrompts();
    } catch (err) {
      console.error('[AI Studio] chargement templates échoué :', err);
      this.setGenStatus('Erreur chargement prompts : ' + (err.message || err), true);
      this._showRetry();
    }
  },

  /** Affiche un bouton « Recharger les prompts » sous la grille (récupérable). */
  _showRetry() {
    const container = this.el.aistudioCardsContainer;
    if (!container) return;
    // Évite les doublons.
    const existing = container.querySelector('.prompt-retry-btn');
    if (existing) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary prompt-retry-btn';
    btn.textContent = '🔄 Recharger les prompts';
    btn.style.marginTop = '8px';
    btn.addEventListener('click', () => {
      btn.remove();
      this.loadTemplates();
    });
    container.appendChild(btn);
  },

  /** Charge les prompts IA internes (utilisés pendant le scraping). */
  async loadInternalPrompts() {
    try {
      if (!window.api || !window.api.listInternalPrompts) return;
      const res = await window.api.listInternalPrompts();
      if (!res || !res.prompts || res.prompts.length === 0) return;
      this.renderInternalCards(res.prompts);
    } catch (err) {
      console.error('[AI Studio] chargement prompts internes échoué :', err);
    }
  },

  /**
   * Génère les cartes pour les prompts IA internes (sans champs à trous,
   * juste un affichage + copie du prompt complet).
   */
  renderInternalCards(prompts) {
    const container = this.el.aistudioCardsContainer;
    for (const p of prompts) {
      const card = document.createElement('div');
      card.className = 'prompt-card prompt-card-internal';
      card.dataset.tplId = p.id;

      const header = document.createElement('div');
      header.className = 'prompt-card-header';
      const title = document.createElement('span');
      title.className = 'prompt-card-title';
      title.textContent = p.title;
      const cat = document.createElement('span');
      cat.className = 'prompt-card-cat';
      cat.textContent = p.category || 'IA interne';
      const toggle = document.createElement('span');
      toggle.className = 'prompt-card-toggle';
      toggle.textContent = '▼';
      header.appendChild(title);
      header.appendChild(cat);
      header.appendChild(toggle);

      const desc = document.createElement('div');
      desc.className = 'prompt-card-desc';
      desc.textContent = p.description || '';

      const body = document.createElement('div');
      body.className = 'prompt-card-body';

      // Zone de prévisualisation du prompt complet
      const preview = document.createElement('pre');
      preview.className = 'prompt-preview';
      preview.textContent = p.template || '';
      preview.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:var(--header-bg,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:6px;padding:10px;font-size:0.75rem;max-height:400px;overflow-y:auto;margin-bottom:10px;';

      const actions = document.createElement('div');
      actions.className = 'prompt-card-actions';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-primary';
      copyBtn.textContent = '📋 Copier le prompt';
      copyBtn.addEventListener('click', async () => {
        try {
          await this.copyToClipboard(p.template || '');
          this.flashCard(p.id, '✅ Prompt copié !');
        } catch (err) {
          this.setGenStatus('❌ ' + (err.message || err), true);
        }
      });
      actions.appendChild(copyBtn);

      body.appendChild(preview);
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
   * Génère les cartes de prompts. Chaque carte est un accordéon indépendant
   * (plusieurs cartes peuvent être ouvertes simultanément).
   */
  renderCards() {
    const container = this.el.aistudioCardsContainer;
    container.innerHTML = '';
    let rendered = 0;

    for (const tmpl of this.templates) {
      // Une carte défectueuse (template mal formé) ne doit pas empêcher les
      // autres de s'afficher. Sans ce try/catch, une seule exception tuait toute
      // la grille et l'onglet paraissait vide (« prompts non visibles »).
      try {
        const card = this._buildCard(tmpl);
        if (card) { container.appendChild(card); rendered++; }
      } catch (err) {
        console.error('[AI Studio] carte prompt échouée :', tmpl && tmpl.id, err);
      }
    }

    if (rendered === 0) {
      this.setGenStatus('⚠️ Aucun prompt n\'a pu être affiché (template invalide).', true);
    } else {
      this.setGenStatus('', false);
    }
  },

  /** Construit le DOM d'une carte de prompt (extrait de renderCards pour le try/catch par carte). */
  _buildCard(tmpl) {
    if (!tmpl || !tmpl.id || !tmpl.template) return null;
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
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn btn-secondary';
      previewBtn.textContent = '👁 Voir le prompt';
      previewBtn.addEventListener('click', () => this.togglePreview(tmpl, card));
      const copyFilled = document.createElement('button');
      copyFilled.className = 'btn btn-primary';
      copyFilled.textContent = '📋 Copier rempli';
      copyFilled.addEventListener('click', () => this.copyFilledPrompt(tmpl));
      const copyRaw = document.createElement('button');
      copyRaw.className = 'btn btn-secondary';
      copyRaw.textContent = '📝 Copier avec trous';
      copyRaw.addEventListener('click', () => this.copyRawPrompt(tmpl));
      actions.appendChild(previewBtn);
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

    return card;
  },

  /**
   * Bascule l'affichage d'une zone de prévisualisation du prompt assemblé
   * (avec les valeurs actuelles des champs) directement dans la carte.
   */
  async togglePreview(tmpl, card) {
    let preview = card.querySelector('.prompt-preview-toggle');
    if (preview) {
      // Si déjà affiché, on le bascule (hide/show)
      preview.style.display = preview.style.display === 'none' ? 'block' : 'none';
      if (preview.style.display === 'none') return;
    } else {
      preview = document.createElement('pre');
      preview.className = 'prompt-preview-toggle';
      preview.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:var(--header-bg,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:6px;padding:10px;font-size:0.75rem;max-height:400px;overflow-y:auto;margin-top:10px;';
      card.querySelector('.prompt-card-body').appendChild(preview);
    }

    // Récupère les valeurs actuelles et assemble le prompt
    const values = {};
    for (const ph of tmpl.placeholders) {
      const input = $('pc_' + tmpl.id + '_' + ph.key);
      if (input) values[ph.key] = input.value;
    }
    try {
      const res = await window.api.buildPrompt(tmpl.id, values);
      if (res && res.prompt) {
        preview.textContent = res.prompt;
      } else {
        preview.textContent = 'Erreur : ' + (res && res.error ? res.error : 'prompt vide');
      }
    } catch (err) {
      preview.textContent = 'Erreur : ' + (err.message || err);
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
      const ok = await this.copyToClipboard(res.prompt);
      if (!ok) throw new Error('Copie impossible (presse-papiers bloqué par le navigateur).');
      this.flashCard(tmpl.id, '✅ Prompt rempli copié !');
    } catch (err) {
      console.error('[AI Studio] copie prompt rempli échouée :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
      this.flashCard(tmpl.id, '❌ Copie échouée');
    }
  },

  /**
   * Copie le prompt brut avec les [TROUS] intacts, pour que l'utilisateur
   * les remplisse directement dans AI Studio.
   */
  async copyRawPrompt(tmpl) {
    // On récupère le template brut directement (avec les [PLACEHOLDERS] intacts).
    const tmplObj = this.templates.find((t) => t.id === tmpl.id);
    const raw = tmplObj ? tmplObj.template : tmpl.template || '';
    try {
      const ok = await this.copyToClipboard(raw);
      if (!ok) throw new Error('Copie impossible (presse-papiers bloqué par le navigateur).');
      this.flashCard(tmpl.id, '✅ Prompt brut copié (avec trous) !');
    } catch (err) {
      console.error('[AI Studio] copie prompt brut échouée :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
      this.flashCard(tmpl.id, '❌ Copie échouée');
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
    // Retourne true si la copie a réussi, false sinon (pour feedback utilisateur).
    // navigator.clipboard peut échouer dans un webview/sandbox (Permissions API) ;
    // on retente via execCommand sur un textarea temporaire.
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
  },

  setGenStatus(msg, isError) {
    const el = this.el.aistudioGenStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : '';
  },

  bindActions(e) {
    e.aistudioOpenJobsBtn.addEventListener('click', async () => {
      try {
        const res = window.api && window.api.openJobsFolder
          ? await window.api.openJobsFolder()
          : await window.api.openFolder(null);
        if (res && res.success === false) {
          alert('Impossible d\'ouvrir le dossier des jobs : ' + (res.error || 'erreur inconnue'));
        }
      } catch (err) {
        alert('Impossible d\'ouvrir le dossier des jobs : ' + (err.message || err));
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

