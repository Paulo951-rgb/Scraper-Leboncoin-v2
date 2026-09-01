'use strict';

/**
 * Module "Navigateur IA Studio" — Refonte complète.
 *
 * Architecture simplifiée :
 *   - Un seul onglet avec navigation par onglets internes (Navigateur / Prompts / Générateur)
 *   - Navigateur : webview AI Studio + barre d'outils
 *   - Prompts : templates préfaits + prompts IA internes, avec copie
 *   - Générateur : création de prompts personnalisés
 *   - Session : état de la connexion Google
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/';

const $ = (id) => document.getElementById(id);

const AiStudioModule = {
  templates: [],
  currentTab: 'browser',
  webviewReady: false,

  init() {
    this.el = {
      // Navigation interne
      tabBrowser: $('aiTabBrowser'),
      tabPrompts: $('aiTabPrompts'),
      tabGenerator: $('aiTabGenerator'),
      tabSession: $('aiTabSession'),
      panelBrowser: $('aiPanelBrowser'),
      panelPrompts: $('aiPanelPrompts'),
      panelGenerator: $('aiPanelGenerator'),
      panelSession: $('aiPanelSession'),

      // Navigateur
      webview: $('aistudioWebview'),
      webviewLoading: $('aistudioWebviewLoading'),
      urlBar: $('aistudioUrlBar'),
      btnBack: $('aistudioBackBtn'),
      btnFwd: $('aistudioFwdBtn'),
      btnReload: $('aistudioReloadBtn'),
      btnHome: $('aistudioHomeBtn'),
      btnLogin: $('aistudioLoginBtn'),
      btnExternal: $('aistudioOpenExternalBtn'),
      browserStatus: $('aiBrowserStatus'),

      // Prompts
      cardsContainer: $('aistudioCardsContainer'),
      promptsStatus: $('aistudioGenStatus'),

      // Générateur
      genForm: $('aiGenForm'),
      genOutput: $('aiGenOutput'),
      genStatus: $('aiGenStatus'),

      // Session
      sessionStatus: $('aiSessionStatus'),
      btnClearSession: $('aiClearSessionBtn'),
      btnOpenJobs: $('aistudioOpenJobsBtn'),
    };

    this.bindTabs();
    this.bindBrowser();
    this.bindGenerator();
    this.bindSession();
    this.loadTemplates();
  },

  // ─── Navigation interne ───────────────────────────────────────────────
  bindTabs() {
    const tabs = [
      { btn: this.el.tabBrowser, panel: this.el.panelBrowser, id: 'browser' },
      { btn: this.el.tabPrompts, panel: this.el.panelPrompts, id: 'prompts' },
      { btn: this.el.tabGenerator, panel: this.el.panelGenerator, id: 'generator' },
      { btn: this.el.tabSession, panel: this.el.panelSession, id: 'session' },
    ];

    for (const t of tabs) {
      if (!t.btn) continue;
      t.btn.addEventListener('click', () => {
        for (const x of tabs) {
          if (x.btn) x.btn.classList.toggle('active', x === t);
          if (x.panel) x.panel.classList.toggle('hidden', x !== t);
        }
        this.currentTab = t.id;
        if (t.id === 'browser') this.invalidateWebview();
      });
    }
  },

  invalidateWebview() {
    const wv = this.el.webview;
    if (wv && wv.getBoundingClientRect) {
      setTimeout(() => {
        const rect = wv.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          setTimeout(() => {}, 100);
        }
      }, 150);
    }
  },

  // ─── Navigateur ──────────────────────────────────────────────────────
  bindBrowser() {
    const wv = this.el.webview;
    if (!wv) return;

    const updateUrl = (url) => { if (this.el.urlBar && url) this.el.urlBar.value = url; };
    const setLoading = (v) => { if (this.el.webviewLoading) this.el.webviewLoading.classList.toggle('hidden', !v); };
    const setStatus = (msg) => { if (this.el.browserStatus) this.el.browserStatus.textContent = msg; };

    wv.addEventListener('did-start-loading', () => { setLoading(true); setStatus('Chargement…'); });
    wv.addEventListener('did-stop-loading', () => { setLoading(false); updateUrl(wv.getURL()); setStatus('Chargé'); });
    wv.addEventListener('did-finish-load', () => { setLoading(false); updateUrl(wv.getURL()); setStatus('Chargé'); this.webviewReady = true; });
    wv.addEventListener('did-navigate', (ev) => { updateUrl(ev?.url); setStatus('Navigation…'); });
    wv.addEventListener('did-navigate-in-page', (ev) => { updateUrl(ev?.url); });
    wv.addEventListener('did-fail-load', (ev) => {
      setLoading(false);
      if (ev && ev.errorCode && ev.errorCode !== -3) {
        setStatus(`Erreur de chargement (${ev.errorDescription || ev.errorCode})`);
      }
    });

    // Barre d'outils
    if (this.el.btnBack) this.el.btnBack.addEventListener('click', () => { try { wv.goBack(); } catch {} });
    if (this.el.btnFwd) this.el.btnFwd.addEventListener('click', () => { try { wv.goForward(); } catch {} });
    if (this.el.btnReload) this.el.btnReload.addEventListener('click', () => { try { wv.reload(); } catch {} });
    if (this.el.btnHome) this.el.btnHome.addEventListener('click', () => { try { wv.loadURL(AI_STUDIO_URL); } catch {} });

    if (this.el.btnLogin) {
      this.el.btnLogin.addEventListener('click', () => {
        const url = (wv.getURL && wv.getURL()) || AI_STUDIO_URL;
        if (window.api?.openAiStudioLogin) window.api.openAiStudioLogin(url);
        else if (window.api?.openExternal) window.api.openExternal(url);
      });
    }

    if (this.el.btnExternal) {
      this.el.btnExternal.addEventListener('click', () => {
        const url = (wv.getURL && wv.getURL()) || AI_STUDIO_URL;
        if (window.api?.openExternal) window.api.openExternal(url);
        else window.open(url, '_blank');
      });
    }

    // URL bar — entrée pour naviguer
    if (this.el.urlBar) {
      this.el.urlBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          let url = this.el.urlBar.value.trim();
          if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
          if (url) { try { wv.loadURL(url); } catch {} }
        }
      });
    }
  },

  // ─── Prompts ─────────────────────────────────────────────────────────
  async loadTemplates() {
    this.setPromptStatus('⏳ Chargement des prompts…', false);
    try {
      if (!window.api?.listPromptTemplates) {
        this.setPromptStatus('Erreur : API prompts indisponible.', true);
        return;
      }
      const res = await window.api.listPromptTemplates();
      if (!res?.templates?.length) {
        this.setPromptStatus('Aucun prompt disponible.', true);
        return;
      }
      this.templates = res.templates;
      this.renderPromptCards();
      this.loadInternalPrompts();
    } catch (err) {
      this.setPromptStatus('Erreur : ' + (err.message || err), true);
    }
  },

  async loadInternalPrompts() {
    try {
      if (!window.api?.listInternalPrompts) return;
      const res = await window.api.listInternalPrompts();
      if (!res?.prompts?.length) return;
      this.renderInternalPromptCards(res.prompts);
    } catch (err) {
      console.error('[AI Studio] prompts internes échoués :', err);
    }
  },

  renderPromptCards() {
    const container = this.el.cardsContainer;
    if (!container) return;
    container.innerHTML = '';

    for (const tmpl of this.templates) {
      try {
        const card = this._buildPromptCard(tmpl);
        if (card) container.appendChild(card);
      } catch (err) {
        console.error('[AI Studio] carte échouée :', tmpl?.id, err);
      }
    }

    this.setPromptStatus(this.templates.length > 0 ? '' : 'Aucun prompt à afficher.', false);
  },

  renderInternalPromptCards(prompts) {
    const container = this.el.cardsContainer;
    if (!container) return;

    const sep = document.createElement('div');
    sep.className = 'prompt-section-sep';
    sep.innerHTML = '<h4>🤖 Prompts IA internes (utilisés par le scraper)</h4>';
    container.appendChild(sep);

    for (const p of prompts) {
      const card = document.createElement('div');
      card.className = 'prompt-card prompt-card-internal';
      card.innerHTML = `
        <div class="prompt-card-header">
          <span class="prompt-card-title">${this._esc(p.title)}</span>
          <span class="prompt-card-cat">${this._esc(p.category || 'IA interne')}</span>
          <span class="prompt-card-toggle">▼</span>
        </div>
        <div class="prompt-card-desc">${this._esc(p.description || '')}</div>
        <div class="prompt-card-body">
          <pre class="prompt-preview">${this._esc(p.template || '')}</pre>
          <div class="prompt-card-actions">
            <button class="btn btn-primary ai-copy-btn" data-text="${this._escAttr(p.template || '')}">📋 Copier</button>
          </div>
        </div>
      `;
      card.querySelector('.prompt-card-header').addEventListener('click', () => card.classList.toggle('expanded'));
      card.querySelector('.ai-copy-btn').addEventListener('click', (e) => {
        this.copyToClipboard(e.target.dataset.text).then(ok => {
          e.target.textContent = ok ? '✅ Copié !' : '❌ Échec';
          setTimeout(() => { e.target.textContent = '📋 Copier'; }, 2000);
        });
      });
      container.appendChild(card);
    }
  },

  _buildPromptCard(tmpl) {
    if (!tmpl?.id || !tmpl.template) return null;
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.tplId = tmpl.id;

    const placeholders = Array.isArray(tmpl.placeholders) ? tmpl.placeholders : [];
    const fieldsHtml = placeholders.map((ph) => {
      const id = `pc_${tmpl.id}_${ph.key}`;
      const input = ph.type === 'textarea'
        ? `<textarea id="${id}" rows="2" placeholder="${this._escAttr(ph.placeholder || '')}">${this._escAttr(ph.default || '')}</textarea>`
        : `<input type="${ph.type === 'number' ? 'number' : 'text'}" id="${id}" placeholder="${this._escAttr(ph.placeholder || '')}" value="${this._escAttr(ph.default || '')}">`;
      return `<div class="prompt-card-field${ph.type === 'textarea' ? ' full' : ''}"><label for="${id}">${this._esc(ph.label)}</label>${input}</div>`;
    }).join('');

    card.innerHTML = `
      <div class="prompt-card-header">
        <span class="prompt-card-title">${this._esc(tmpl.title)}</span>
        <span class="prompt-card-cat">${this._esc(tmpl.category || '')}</span>
        <span class="prompt-card-toggle">▼</span>
      </div>
      <div class="prompt-card-desc">${this._esc(tmpl.description || '')}</div>
      <div class="prompt-card-body">
        <div class="prompt-card-fields">${fieldsHtml}</div>
        <div class="prompt-card-actions">
          <button class="btn btn-secondary ai-preview-btn">👁 Prévisualiser</button>
          <button class="btn btn-primary ai-copy-filled-btn">📋 Copier rempli</button>
          <button class="btn btn-secondary ai-copy-raw-btn">📝 Copier avec trous</button>
        </div>
        <pre class="prompt-preview-toggle hidden"></pre>
      </div>
    `;

    const header = card.querySelector('.prompt-card-header');
    header.addEventListener('click', () => card.classList.toggle('expanded'));

    const preview = card.querySelector('.prompt-preview-toggle');
    card.querySelector('.ai-preview-btn').addEventListener('click', async () => {
      const values = {};
      for (const ph of placeholders) {
        const el = $(`pc_${tmpl.id}_${ph.key}`);
        if (el) values[ph.key] = el.value;
      }
      try {
        const res = await window.api.buildPrompt(tmpl.id, values);
        if (res?.prompt) {
          preview.textContent = res.prompt;
          preview.classList.remove('hidden');
        } else {
          preview.textContent = 'Erreur : ' + (res?.error || 'prompt vide');
          preview.classList.remove('hidden');
        }
      } catch (err) {
        preview.textContent = 'Erreur : ' + err.message;
        preview.classList.remove('hidden');
      }
    });

    card.querySelector('.ai-copy-filled-btn').addEventListener('click', async (e) => {
      const values = {};
      for (const ph of placeholders) {
        const el = $(`pc_${tmpl.id}_${ph.key}`);
        if (el) values[ph.key] = el.value;
      }
      try {
        const res = await window.api.buildPrompt(tmpl.id, values);
        if (!res?.prompt) throw new Error(res?.error || 'Prompt vide');
        const ok = await this.copyToClipboard(res.prompt);
        e.target.textContent = ok ? '✅ Copié !' : '❌ Échec';
      } catch (err) {
        e.target.textContent = '❌ ' + err.message;
      }
      setTimeout(() => { e.target.textContent = '📋 Copier rempli'; }, 2000);
    });

    card.querySelector('.ai-copy-raw-btn').addEventListener('click', async (e) => {
      const ok = await this.copyToClipboard(tmpl.template || '');
      e.target.textContent = ok ? '✅ Copié !' : '❌ Échec';
      setTimeout(() => { e.target.textContent = '📝 Copier avec trous'; }, 2000);
    });

    return card;
  },

  // ─── Générateur ───────────────────────────────────────────────────────
  bindGenerator() {
    const form = this.el.genForm;
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const output = this.el.genOutput;
      const status = this.el.genStatus;
      if (output) output.textContent = '';
      if (status) status.textContent = '⏳ Génération en cours…';

      const data = {
        domain: form.genDomain?.value || '',
        objective: form.genObjective?.value || '',
        customHints: form.genHints?.value || '',
        vars: form.genVars?.value || '',
        ollamaUrl: form.genOllamaUrl?.value || 'http://127.0.0.1:11434',
        ollamaModel: form.genModel?.value || '',
        priceRange: form.genPriceRange?.value || '',
        topN: form.genTopN?.value || '10',
        rankings: form.genRankings?.value || '',
      };

      try {
        if (!window.api?.generatePrompt) throw new Error('API generatePrompt indisponible');
        const res = await window.api.generatePrompt(data);
        if (res?.error) throw new Error(res.error);
        if (!res?.prompt) throw new Error('Prompt vide');
        if (output) {
          output.textContent = res.prompt;
          output.classList.remove('hidden');
        }
        if (status) status.textContent = '';
      } catch (err) {
        if (status) status.textContent = '❌ ' + err.message;
      }
    });

    // Bouton copier le résultat
    const copyBtn = $('aiGenCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const text = this.el.genOutput?.textContent || '';
        if (!text) return;
        const ok = await this.copyToClipboard(text);
        copyBtn.textContent = ok ? '✅ Copié !' : '❌ Échec';
        setTimeout(() => { copyBtn.textContent = '📋 Copier'; }, 2000);
      });
    }
  },

  // ─── Session ─────────────────────────────────────────────────────────
  bindSession() {
    if (this.el.btnOpenJobs) {
      this.el.btnOpenJobs.addEventListener('click', async () => {
        try {
          const res = window.api?.openJobsFolder ? await window.api.openJobsFolder() : await window.api.openFolder(null);
          if (res?.success === false) alert('Erreur : ' + (res.error || 'impossible d\'ouvrir le dossier'));
        } catch (err) { alert('Erreur : ' + err.message); }
      });
    }

    if (this.el.btnClearSession) {
      this.el.btnClearSession.addEventListener('click', () => {
        if (confirm('Effacer la session AI Studio ? Vous devrez vous reconnecter.')) {
          localStorage.removeItem('aistudio-session');
          this.updateSessionStatus();
        }
      });
    }

    this.updateSessionStatus();
  },

  updateSessionStatus() {
    const el = this.el.sessionStatus;
    if (!el) return;
    const hasSession = localStorage.getItem('aistudio-session');
    el.innerHTML = hasSession
      ? '<span class="status-dot status-online"></span> Session active'
      : '<span class="status-dot status-offline"></span> Aucune session (connectez-vous via le navigateur)';
  },

  // ─── Utilitaires ──────────────────────────────────────────────────────
  setPromptStatus(msg, isError) {
    const el = this.el.promptsStatus;
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#e57373' : '';
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      return ok;
    }
  },

  _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  _escAttr(str) {
    return String(str == null ? '' : str).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/&/g, '&amp;');
  },
};

window.aiStudioModule = AiStudioModule;
document.addEventListener('DOMContentLoaded', () => {
  try { AiStudioModule.init(); } catch (err) { console.error('[AI Studio] init échoué :', err); }
});
