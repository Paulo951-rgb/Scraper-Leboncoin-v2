'use strict';

/**
 * Module "Navigateur IA Studio + Analyse de fichiers".
 *
 * Logique renderer isolée du reste de app.js pour garder le module indépendant
 * et lisible. Exposé sur window.aiStudioModule, initialisé au chargement.
 *
 * Note : les prompts/domaines sont intégrés ici (et pas importés depuis
 * src/main/config/aiStudioPrompts.js) car le renderer est sandboxé et ne peut
 * pas require de modules hors preload. Les deux définitions sont volontairement
 * dupliquées : si vous modifiez l'une, modifiez l'autre (un test vérifie la
 * cohérence du renderer côté prompts).
 */

const AI_STUDIO_URL = 'https://aistudio.google.com/';

const DOMAINS = [
  { id: 'hardware', label: '🖥️ PC / Hardware', defaults: { searchContext: 'PC fixes', productFamily: 'PC fixes', component: 'SSD', capacity: '500 Go', capacity2: '1 To', dealThreshold: '30 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'gpu', label: '🎮 Cartes graphiques', defaults: { searchContext: 'cartes graphiques', productFamily: 'cartes graphiques', component: 'GPU', capacity: '8 Go', capacity2: '12 Go', dealThreshold: '150 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'smartphone', label: '📱 Smartphones', defaults: { searchContext: 'smartphones', productFamily: 'smartphones', component: 'modèle', capacity: '128 Go', capacity2: '256 Go', dealThreshold: '150 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'books', label: '📚 Livres', defaults: { searchContext: 'livres', productFamily: 'livres', component: 'collection', capacity: 'Folio Junior', capacity2: 'Livre de Poche', dealThreshold: '5 €', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
  { id: 'custom', label: '✏️ Personnalisé', defaults: { searchContext: 'produits', productFamily: 'produits', component: 'produit', capacity: '—', capacity2: '—', dealThreshold: '—', topN: 50, flipN: 20, compN: 20, nuggetN: 20, avoidN: 10 } },
];

const MASTER_PROMPT = `Rôle :

Tu es un expert en {{productFamily}}, achat-revente et analyse d'annonces d'occasion sur Le Bon Coin.

Je te fournis un fichier contenant plusieurs centaines/milliers d'annonces issues d'une recherche « {{searchContext}} ». Les annonces peuvent contenir des {{productFamily}}, des produits liés, des composants, des accessoires, des lots, des machines incomplètes, etc.

## Mission

Analyse 100 % des annonces, sans en oublier et sans te limiter aux annonces qui correspondent exactement à la recherche initiale.

Pour chaque annonce, identifie au mieux :
- le type de produit ;
- sa catégorie ;
- ses caractéristiques ;
- son prix ;
- sa valeur réelle estimée ;
- son intérêt potentiel.

Ne rejette pas automatiquement une annonce simplement parce qu'elle ne correspond pas à la recherche initiale.

## Recherche des meilleures opportunités

Cherche notamment :
- les meilleurs rapports performances/prix ;
- les meilleurs rapports qualité/prix ;
- les meilleures affaires pour l'achat-revente ;
- les produits fortement sous-évalués ;
- les annonces dont la valeur réelle semble largement supérieure au prix demandé ;
- les produits rares ou particulièrement intéressants ;
- les annonces présentant une marge potentielle importante.

Exemple type de pépite : un {{component}} {{capacity2}} à {{dealThreshold}} qui représente une très bonne affaire.

## Opportunités indirectes

Analyse également les annonces qui peuvent être intéressantes même si le produit complet n'est pas intéressant.

Par exemple :
- un produit intéressant uniquement pour son écran ;
- une machine intéressante pour un de ses composants ;
- un produit intéressant pour son processeur / sa mémoire ;
- un stockage intéressant à récupérer ;
- une alimentation intéressante ;
- de la mémoire intéressante ;
- des composants vendables séparément ;
- une machine en panne mais réparable ;
- une machine incomplète mais dont les composants restants ont une forte valeur ;
- un lot dont la valeur des composants dépasse le prix du lot.

## Pour chaque annonce intéressante

Indique si possible :
- catégorie ;
- prix demandé ;
- valeur réelle estimée ;
- score global /100 ;
- rapport qualité/prix ;
- potentiel d'achat-revente ;
- composants intéressants ;
- estimation de la valeur des composants récupérables ;
- points forts ;
- points faibles ;
- risques éventuels ;
- recommandation : Acheter / Négocier / Surveiller / Éviter.

## Détection des risques

Repère notamment :
- prix anormalement bas ;
- description incohérente ;
- caractéristiques contradictoires ;
- informations importantes manquantes ;
- matériel potentiellement défectueux ;
- photos ou description suspectes ;
- éléments pouvant indiquer un risque d'arnaque.

Attribue un niveau de risque : Faible / Moyen / Élevé.

Ne considère jamais automatiquement une annonce comme une arnaque sans éléments suffisants : indique plutôt « suspicion » et explique pourquoi.

## Classements finaux

À la fin de l'analyse, crée :

### Top {{topN}} — Meilleures affaires
Toutes catégories confondues.

### Top {{flipN}} — Achat-revente
Les annonces présentant le meilleur potentiel de marge.

### Top {{compN}} — Récupération de composants
Les annonces intéressantes principalement pour leurs composants.

### Top {{nuggetN}} — Pépite sous-évaluée
Les annonces où la différence entre le prix demandé et la valeur estimée est particulièrement intéressante.

### Top {{avoidN}} — À éviter
Les annonces présentant le moins bon rapport intérêt/prix ou les risques les plus importants.

Pour chaque classement, explique brièvement pourquoi l'annonce est intéressante ou non.

## Objectif final

L'objectif n'est pas simplement de trouver les annonces qui correspondent à la recherche initiale.

L'objectif est de fouiller l'intégralité du fichier pour trouver les véritables pépites cachées : produits sous-évalués, excellents rapports valeur/prix, opportunités d'achat-revente, composants récupérables et annonces inhabituelles pouvant générer une bonne marge.

Ne te contente donc pas de rechercher des mots-clés : analyse le contenu et la valeur réelle de chaque annonce.`;

const PROMPTS = [
  { id: 'master', label: '🎯 Analyse complète (Top + achat-revente + composants + pépites)', template: MASTER_PROMPT },
  { id: 'top-deals', label: '🏆 Top des meilleures affaires', template: `Tu es un expert en {{productFamily}} et achat-revente sur Le Bon Coin.

Je te fournis un fichier d'annonces de recherche « {{searchContext}} ».

Analyse 100 % des annonces et établis un Top {{topN}} des meilleures affaires toutes catégories confondues (rapport qualité/prix, valeur réelle supérieure au prix demandé, produits rares).

Pour chacune : catégorie, prix demandé, valeur réelle estimée, score /100, points forts, points faibles, recommandation (Acheter / Négocier / Surveiller / Éviter) et justification courte.

Ne rejette pas une annonce sous prétexte qu'elle ne correspond pas exactement à la recherche initiale : cherche les pépites cachées dans tout le fichier.` },
  { id: 'resell-flip', label: '💸 Achat-revente / Flip (marge nette)', template: `Tu es un expert en achat-revente de {{productFamily}} sur Le Bon Coin.

Je te fournis un fichier d'annonces de recherche « {{searchContext}} ».

Analyse 100 % des annonces et établis un Top {{flipN}} des annonces présentant le meilleur potentiel de marge nette à la revente.

Pour chacune : prix demandé, valeur de revente estimée, marge potentielle (€ et %), composants/produit pouvant être revendus séparément, risque (Faible/Moyen/Élevé), recommandation et justification courte.

Inclus les opportunités indirectes (lot dont les composants valent plus que le prix du lot, machine démontable, etc.).` },
  { id: 'components', label: '🔧 Récupération de composants', template: `Tu es un expert en {{productFamily}} et valorisation de composants récupérables sur Le Bon Coin.

Je te fournis un fichier d'annonces de recherche « {{searchContext}} ».

Analyse 100 % des annonces et établis un Top {{compN}} des annonces intéressantes principalement pour leurs composants récupérables.

Pour chacune : composants intéressants ({{component}}, mémoire, stockage, alimentation, écran, etc.), estimation de la valeur des composants récupérables, prix demandé, marge potentielle si revente pièce par pièce, risque et recommandation.

Inclus les machines incomplètes, en panne mais réparables, et les lots dont la valeur des composants dépasse le prix du lot.` },
  { id: 'undervalued', label: '💎 Pépites sous-évaluées', template: `Tu es un expert en {{productFamily}} sur Le Bon Coin.

Je te fournis un fichier d'annonces de recherche « {{searchContext}} ».

Analyse 100 % des annonces et établis un Top {{nuggetN}} des annonces les plus sous-évaluées (valeur réelle estimée largement supérieure au prix demandé).

Exemple type : un {{component}} {{capacity2}} à {{dealThreshold}} qui représente une très bonne affaire.

Pour chacune : catégorie, prix demandé, valeur réelle estimée, écart (€ et %), justification de la sous-évaluation, risque (Faible/Moyen/Élevé) et recommandation.` },
  { id: 'risk-detection', label: "🚨 Détection d'arnaques & risques", template: `Tu es un expert en détection d'arnaques sur Le Bon Coin pour le domaine {{productFamily}}.

Je te fournis un fichier d'annonces de recherche « {{searchContext}} ».

Analyse 100 % des annonces et repère les annonces présentant des risques :
- prix anormalement bas ;
- description incohérente ;
- caractéristiques contradictoires ;
- informations importantes manquantes ;
- matériel potentiellement défectueux ;
- photos ou description suspectes ;
- éléments pouvant indiquer une arnaque.

Attribue un niveau de risque : Faible / Moyen / Élevé.

Ne considère jamais automatiquement une annonce comme une arnaque sans éléments suffisants : indique plutôt « suspicion » et explique pourquoi.

Établis un Top {{avoidN}} des annonces à éviter (le moins bon rapport intérêt/prix ou les risques les plus importants), avec justification.` },
];

const VAR_FIELDS = ['searchContext', 'productFamily', 'component', 'capacity', 'capacity2', 'dealThreshold', 'topN', 'flipN', 'compN', 'nuggetN', 'avoidN'];

function renderPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars && vars[key];
    return v !== undefined && v !== null && v !== '' ? String(v) : m;
  });
}

const $ = (id) => document.getElementById(id);

const AiStudioModule = {
  init() {
    const els = [
      'aistudioDomainSelect', 'aistudioPromptSelect',
      'aistudioGenerateBtn', 'aistudioCopyBtn',
      'aistudioPromptOutput',
      'aistudioWebview', 'aistudioWebviewLoading',
      'aistudioBackBtn', 'aistudioFwdBtn', 'aistudioReloadBtn', 'aistudioHomeBtn',
      'aistudioUrlBar', 'aistudioOpenExternalBtn',
    ];
    const e = {};
    let missing = false;
    for (const id of els) { e[id] = $(id); if (!e[id]) { console.warn('[AI Studio] élément manquant :', id); missing = true; } }
    if (missing) return;

    this.el = e;
    this.populateDomainSelect();
    this.populatePromptSelect();
    this.applyDomainDefaults(DOMAINS[0].id);
    this.bindPrompts(e);
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

  populatePromptSelect() {
    const sel = this.el.aistudioPromptSelect;
    sel.innerHTML = '';
    for (const p of PROMPTS) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
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

  bindPrompts(e) {
    e.aistudioDomainSelect.addEventListener('change', (ev) => this.applyDomainDefaults(ev.target.value));
    e.aistudioGenerateBtn.addEventListener('click', () => this.generatePrompt());
    e.aistudioCopyBtn.addEventListener('click', () => this.copyPrompt());
  },

  generatePrompt() {
    const promptId = this.el.aistudioPromptSelect.value;
    const prompt = PROMPTS.find((p) => p.id === promptId) || PROMPTS[0];
    const vars = this.collectVars();
    const rendered = renderPrompt(prompt.template, vars);
    this.el.aistudioPromptOutput.value = rendered;
    return rendered;
  },

  async copyPrompt() {
    let text = this.el.aistudioPromptOutput.value;
    if (!text) text = this.generatePrompt();
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
