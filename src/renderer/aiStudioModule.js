'use strict';

/**
 * Module "Navigateur IA Studio + Bibliothèque de prompts préfaits".
 *
 * Logique renderer isolée du reste de app.js pour garder le module indépendant
 * et lisible. Exposé sur window.aiStudioModule, initialisé au chargement.
 *
 * V2 : remplace l'ancien générateur de prompts par IA (Ollama) par une
 * bibliothèque de prompts préfaits à trous. L'utilisateur sélectionne un
 * template, remplit les placeholders, et le prompt est assemblé instantanément
 * (aucune IA, aucun serveur, aucune clé API).
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/';

const $ = (id) => document.getElementById(id);

const AiStudioModule = {
  /** Templates chargés depuis le main process via IPC. */
  templates: [],
  /** Template actuellement sélectionné. */
  currentTemplate: null,

  init() {
    const els = [
      'aistudioTemplateSelect', 'aistudoTemplateDesc',
      'aistudioFieldsContainer',
      'aistudioApplyBtn', 'aistudioCopyBtn', 'aistudioGenStatus',
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
    this.bindActions(e);
    this.bindBrowser(e);
    this.loadTemplates();
  },

  /** Charge les templates depuis le main process via IPC. */
  async loadTemplates() {
    try {
      if (!window.api || !window.api.listPromptTemplates) {
        // Fallback : si l'IPC n'est pas disponible, on ne peut pas charger.
        this.setGenStatus('Erreur : API prompts préfaits indisponible.', true);
        return;
      }
      const res = await window.api.listPromptTemplates();
      if (!res || !res.templates || res.templates.length === 0) {
        this.setGenStatus('Aucun prompt préfait disponible.', true);
        return;
      }
      this.templates = res.templates;
      this.populateTemplateSelect();
      if (this.templates.length > 0) {
        this.selectTemplate(this.templates[0].id);
      }
    } catch (err) {
      console.error('[AI Studio] chargement templates échoué :', err);
      this.setGenStatus('Erreur chargement prompts : ' + (err.message || err), true);
    }
  },

  populateTemplateSelect() {
    const sel = this.el.aistudioTemplateSelect;
    sel.innerHTML = '';
    // Grouper par catégorie pour la lisibilité.
    const byCategory = {};
    for (const t of this.templates) {
      const cat = t.category || 'Autres';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(t);
    }
    for (const [cat, items] of Object.entries(byCategory)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = cat;
      for (const t of items) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = t.title;
        optgroup.appendChild(o);
      }
      sel.appendChild(optgroup);
    }
  },

  selectTemplate(templateId) {
    const tmpl = this.templates.find((t) => t.id === templateId);
    if (!tmpl) return;
    this.currentTemplate = tmpl;
    if (this.el.aistudoTemplateDesc) {
      this.el.aistudoTemplateDesc.textContent = tmpl.description || '';
    }
    this.renderFields(tmpl);
    this.setGenStatus('');
  },

  /** Génère les champs de formulaire dynamiquement selon les placeholders. */
  renderFields(tmpl) {
    const container = this.el.aistudioFieldsContainer;
    container.innerHTML = '';

    for (const ph of tmpl.placeholders) {
      const group = document.createElement('div');
      group.className = 'form-group';

      const label = document.createElement('label');
      label.textContent = ph.label;
      label.htmlFor = 'tpl_' + ph.key;

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
      input.id = 'tpl_' + ph.key;
      input.className = 'filter-input';
      if (ph.placeholder) input.placeholder = ph.placeholder;
      if (ph.default !== undefined && ph.default !== null) input.value = ph.default;

      group.appendChild(label);
      group.appendChild(input);
      container.appendChild(group);
    }
  },

  /** Récupère les valeurs des champs dynamiques. */
  collectFieldValues() {
    const values = {};
    if (!this.currentTemplate) return values;
    for (const ph of this.currentTemplate.placeholders) {
      const input = $('tpl_' + ph.key);
      if (input) values[ph.key] = input.value;
    }
    return values;
  },

  setGenStatus(msg, isError) {
    const el = this.el.aistudioGenStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : '';
  },

  bindActions(e) {
    e.aistudioTemplateSelect.addEventListener('change', (ev) => this.selectTemplate(ev.target.value));
    e.aistudioOpenJobsBtn.addEventListener('click', () => {
      if (window.api && window.api.openFolder) {
        window.api.openFolder(null);
      }
    });
    e.aistudioApplyBtn.addEventListener('click', () => this.applyPrompt());
    e.aistudioCopyBtn.addEventListener('click', () => this.copyPrompt());
  },

  /** Assemble le prompt à partir du template + valeurs et l'affiche. */
  async applyPrompt() {
    if (!this.currentTemplate) {
      this.setGenStatus('Sélectionnez d\'abord un prompt.', true);
      return;
    }
    const btn = this.el.aistudioApplyBtn;
    const orig = btn.textContent;
    btn.disabled = true;
    try {
      const values = this.collectFieldValues();
      const res = await window.api.buildPrompt(this.currentTemplate.id, values);
      if (!res || res.error) throw new Error(res ? res.error : 'Erreur inconnue');
      const prompt = (res && res.prompt) || '';
      if (!prompt) throw new Error('Prompt vide.');
      this.el.aistudioPromptOutput.value = prompt;
      this.setGenStatus('✅ Prompt assemblé (' + prompt.length + ' caractères). Prêt à copier.');
    } catch (err) {
      console.error('[AI Studio] assemblage prompt échoué :', err);
      this.setGenStatus('❌ ' + (err && err.message ? err.message : err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  },

  async copyPrompt() {
    let text = this.el.aistudioPromptOutput.value;
    if (!text) { this.setGenStatus('Appliquez d\'abord un prompt.', true); return; }
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
