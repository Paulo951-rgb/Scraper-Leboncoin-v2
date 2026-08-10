'use strict';

/**
 * ImageAnalyzer — analyse les images des annonces via IA Vision.
 *
 * Pour chaque annonce, télécharge les 3 premières images, les convertit en
 * base64, et les envoie à un modèle vision (Gemini Vision ou Ollama LLaVA).
 *
 * L'IA renvoie un verdict structuré :
 *   - photoType : 'REAL_PRODUCT' | 'STOCK_PHOTO' | 'SCREENSHOT' | 'UNCLEAR'
 *   - visibleCondition : 'NEW' | 'LIKE_NEW' | 'GOOD' | 'WORN' | 'DAMAGED'
 *   - visibleDefects : string[] (rayures, chocs, taches…)
 *   - authenticityScore : 0-100 (confiance que la photo est authentique)
 *   - summary : courte phrase résumant l'analyse visuelle
 *
 * Le cache IA (aiCache.js) est réutilisé : la clé de cache est préfixée par
 * 'vision:' pour distinguer des analyses texte.
 */

const { truncate } = require('../../utils/diagnostics');
const aiCache = require('./aiCache');

const CACHE_PREFIX = 'vision';
const MAX_IMAGES = 3;

class ImageAnalyzer {
  /**
   * @param {object} aiConfig   { provider, model, apiKey, ollamaUrl, concurrency }
   * @param {object} opts       { onProgress, useCache }
   */
  constructor(aiConfig, opts = {}) {
    this.provider = aiConfig?.provider || 'ollama';
    this.model = aiConfig?.model || 'llava';
    this.apiKey = aiConfig?.apiKey || '';
    this.ollamaUrl = aiConfig?.ollamaUrl || 'http://127.0.0.1:11434';
    this.concurrency = aiConfig?.concurrency || 4;
    this.onProgress = opts.onProgress || (() => {});
    this.useCache = opts.useCache !== false;
    this._stopRequested = false;
  }

  stop() {
    this._stopRequested = true;
  }

  /**
   * Analyse un batch d'annonces en parallèle.
   * @param {Array} ads   annonces avec .id, .images (string[])
   * @returns {Map<string, object>}  adId -> visionData
   */
  async analyzeAll(ads) {
    const targets = ads.filter((a) => a.id && Array.isArray(a.images) && a.images.length > 0);
    const results = new Map();

    if (targets.length === 0) {
      this.onProgress({ percent: 100, status: 'Aucune image à analyser.' });
      return results;
    }

    this.onProgress({ percent: 0, status: `Analyse visuelle de ${targets.length} annonce(s)...` });

    // Lookup cache d'abord
    const toAnalyze = [];
    let cacheHits = 0;
    for (const ad of targets) {
      if (this.useCache) {
        const cached = aiCache.get(ad.id, CACHE_PREFIX);
        if (cached) {
          results.set(ad.id, cached.specs || cached);
          cacheHits++;
          continue;
        }
      }
      toAnalyze.push(ad);
    }

    if (cacheHits > 0) {
      this.onProgress({ percent: 10, status: `${cacheHits} annonce(s) déjà analysées (cache).` });
    }

    // Traitement parallèle
    const queue = [...toAnalyze];
    const counter = { done: 0 };
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, () => this._worker(queue, results, counter));

    const total = toAnalyze.length;
    const reportInterval = setInterval(() => {
      this.onProgress({ percent: 10 + Math.round((counter.done / total) * 88), status: `Vision IA : ${counter.done}/${total} analysée(s)` });
    }, 3000);

    await Promise.all(workers);
    clearInterval(reportInterval);

    this.onProgress({ percent: 100, status: `Analyse visuelle terminée — ${counter.done}/${total} (${cacheHits} cache).` });
    return results;
  }

  async _worker(queue, results, counter) {
    while (queue.length > 0 && !this._stopRequested) {
      const ad = queue.shift();
      if (!ad) break;
      try {
        const vision = await this.analyzeAd(ad);
        results.set(ad.id, vision);
        if (this.useCache && vision) {
          aiCache.set(ad.id, vision, CACHE_PREFIX);
        }
      } catch (err) {
        // fallback : on ne plante pas tout pour une image
        const fallback = this._fallback(err.message);
        results.set(ad.id, fallback);
        if (this.useCache) {
          aiCache.set(ad.id, fallback, CACHE_PREFIX);
        }
      }
      counter.done++;
    }
  }

  /**
   * Analyse une annonce : télécharge les images, les envoie à l'IA Vision.
   */
  async analyzeAd(ad) {
    const images = ad.images.slice(0, MAX_IMAGES);
    const base64Images = [];

    for (const url of images) {
      try {
        const b64 = await this._fetchImageAsBase64(url);
        base64Images.push(b64);
      } catch {
        // Image inaccessible — on continue avec ce qu'on a
      }
    }

    if (base64Images.length === 0) {
      return this._fallback('Aucune image accessible');
    }

    if (this.provider === 'ollama') {
      return await this._callOllamaVision(base64Images, ad);
    }
    throw new Error(`Provider vision non supporté : ${this.provider}`);
  }

  async _fetchImageAsBase64(url) {
    // AbortController : Node.js fetch ne supporte pas l'option `timeout`.
    // Sans ça, une image inaccessible pouvait bloquer le worker indéfiniment.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return {
        data: Buffer.from(buf).toString('base64'),
        mimeType: res.headers.get('content-type') || 'image/jpeg',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async _callOllamaVision(images, ad) {
    const prompt = this._buildPrompt(ad);
    const imagesPayload = images.map((img) => img.data);

    const body = {
      model: this.model,
      prompt,
      images: imagesPayload,
      stream: false,
      options: { temperature: 0.2, num_ctx: 2048 },
      format: 'json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let res;
    try {
      res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama Vision HTTP ${res.status} : ${truncate(detail, 200)}`);
    }

    const data = await res.json();
    return this._parseResponse(data.response || '');
  }

  _buildPrompt(ad) {
    return `Tu es un expert en analyse visuelle d'annonces de vente en ligne.
Analyse les ${MAX_IMAGES} premières images de cette annonce et réponds en JSON UNIQUEMENT.

Annonce : "${truncate(ad.title || '', 80)}" — prix : ${ad.price}€

Réponds avec ce format JSON exact :
{
  "photoType": "REAL_PRODUCT | STOCK_PHOTO | SCREENSHOT | UNCLEAR",
  "visibleCondition": "NEW | LIKE_NEW | GOOD | WORN | DAMAGED",
  "visibleDefects": ["rayures", "chocs", ...],
  "authenticityScore": 0-100,
  "summary": "Phrase courte résumant l'analyse visuelle"
}

photoType : type de photo (REAL_PRODUCT=produit réel photographié, STOCK_PHOTO=photo constructeur/marketing, SCREENSHOT=capture d'écran, UNCLEAR=indéterminé).
visibleCondition : état visible du produit sur les photos.
visibleDefects : liste des défauts visibles (vide si aucun).
authenticityScore : confiance que la photo est authentique (0-100).
summary : résumé en une phrase.`;
  }

  _parseResponse(text) {
    // Essayer de parser le JSON depuis la réponse
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Parfois l'IA renvoie du JSON dans du markdown
      const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
      if (match) {
        try {
          parsed = JSON.parse(match[1]);
        } catch {
          return this._fallback('Réponse non-JSON');
        }
      } else {
        return this._fallback('Réponse non-JSON');
      }
    }

    return {
      photoType: parsed.photoType || 'UNCLEAR',
      visibleCondition: parsed.visibleCondition || 'GOOD',
      visibleDefects: Array.isArray(parsed.visibleDefects) ? parsed.visibleDefects : [],
      authenticityScore: Math.max(0, Math.min(100, parseInt(parsed.authenticityScore, 10) || 50)),
      summary: typeof parsed.summary === 'string' ? truncate(parsed.summary, 200) : 'Analyse indisponible',
    };
  }

  _fallback(reason) {
    return {
      photoType: 'UNCLEAR',
      visibleCondition: 'GOOD',
      visibleDefects: [],
      authenticityScore: 50,
      summary: `Analyse visuelle indisponible : ${reason}`,
    };
  }
}

module.exports = { ImageAnalyzer };
