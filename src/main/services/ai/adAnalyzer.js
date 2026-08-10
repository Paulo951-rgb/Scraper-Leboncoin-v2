'use strict';

/**
 * AdAnalyzer — IA 1 : analyse d'une annonce (texte + vision) pendant le scraping.
 *
 * Mission : reconstituer PRÉCISÉMENT ce qu'est réellement l'objet vendu, en
 * croisant toutes les informations disponibles :
 *   - le titre de l'annonce (souvent vague : « Carte graphique »)
 *   - la description (modèle exact, état, défauts…)
 *   - les informations déjà récupérées par le scraper (prix, catégorie, vendeur…)
 *   - les photos de l'annonce, analysées par l'IA Vision
 *
 * L'IA produit un RÉSUMÉ COURT, CLAIR, PRÉCIS et COMPLET du produit, plus une
 * liste d'informations importantes (modèle exact, état, défauts, éléments
 * cassés/manquants, « HS », « pour pièces », fonctionnement normal, accessoires).
 *
 * Pas de note, pas de score, pas de points : juste une compréhension de l'objet.
 *
 * Universelle : fonctionne sur n'importe quel type d'annonce (informatique,
 * livres, meubles, voitures, maisons, électroménager…).
 *
 * Un seul appel Ollama (llava) recevant texte + images simultanément.
 *
 * Si la vision échoue (pas de modèle vision / pas d'images), on dégrade vers
 * un appel texte uniquement.
 */

const { getAIProvider } = require('./providers/aiProviderRegistry');
const aiCache = require('./aiCache');
const { truncate, formatMs } = require('../../utils/diagnostics');

const CACHE_PREFIX = 'analyse';
const MAX_IMAGES = 3;
const MAX_DESC_CHARS = 800;
// Plafond par image : au-delà, on ignore (analyse texte-seul) pour éviter de
// saturer le contexte Ollama / la mémoire avec un base64 de ~27 Mo pour 20 Mo.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const VISION_TIMEOUT_MS = 180000; // les modèles vision sont lents
const TEXT_TIMEOUT_MS = 120000;

const SYSTEM = `Tu es un expert en identification et évaluation de produits vendus en ligne sur Leboncoin (et plus généralement sur les sites de vente entre particuliers/professionnels).
On te donne UNE annonce. Tu dois reconstituer PRÉCISÉMENT ce qu'est réellement l'objet vendu, en croisant TOUTES les informations disponibles : le titre, la description, les données techniques récupérées par le scraper, ET les photos (si présentes).

IMPORTANT :
- Le titre est souvent vague (ex: "Carte graphique"). La description et les photos donnent le modèle exact et les caractéristiques. Croise tout pour identifier le produit RÉEL.
- Releve TOUTES les informations importantes : modèle exact, marque, état, défauts, éléments cassés ou manquants, "HS", "pour pièces", fonctionnement normal, accessoires présents, etc.
- Si les photos contredisent le texte, signale-le.
- Fonctionne pour N'IMPORTE QUEL type d'annonce : informatique, livres, meubles, voitures, maisons, électroménager, plantes, vêtements, etc. Adapte les critères pertinents au type de produit.
- Ne Donne PAS de note ni de score. Ne Donne PAS d'estimation de prix (ce n'est pas ton rôle).
- Réponds UNIQUEMENT avec un JSON valide, sans préambule ni markdown.`;

function buildPrompt(ad) {
  const desc = (ad.description || '').slice(0, MAX_DESC_CHARS);
  const meta = [];
  if (ad.price != null) meta.push(`Prix de l'annonce: ${ad.price} €`);
  if (ad.category) meta.push(`Catégorie récupérée: ${ad.category}`);
  if (ad.seller) meta.push(`Vendeur: ${ad.seller}${ad.isPro ? ' (Pro)' : ''}`);
  if (ad.sellerRating != null) meta.push(`Note vendeur: ${ad.sellerRating}${ad.sellerRatingCount != null ? ` (${ad.sellerRatingCount} avis)` : ''}`);
  if (ad.deliveryMode && ad.deliveryMode !== 'inconnu') meta.push(`Mode de remise: ${ad.deliveryMode === 'livraison' ? 'livraison' : 'main propre'}`);
  if (ad.city) meta.push(`Localisation: ${ad.city}${ad.zipcode ? ' ' + ad.zipcode : ''}`);

  const jsonSpec = `{
  "identifiedProduct": "Nom précis du produit réellement vendu (modèle exact si identifiable, sinon description la plus précise possible)",
  "summary": "Résumé court, clair, précis et complet du produit (1-3 phrases). Doit permettre d'identifier sans ambiguïté l'objet vendu.",
  "category": "Type de produit (ex: Carte graphique, Smartphone, Livre, Meuble, Voiture, Électroménager...)",
  "attributes": {
    "brand": "Marque si identifiable, sinon null",
    "model": "Modèle exact si identifiable, sinon null",
    "condition": "État réel déduit (ex: neuf, très bon état, bon état, état moyen, HS, pour pièces...)",
    "defects": ["liste des défauts visibles ou mentionnés, tableau vide si aucun"],
    "missing": ["éléments cassés ou manquants, tableau vide si aucun"],
    "accessories": ["accessoires présents, tableau vide si aucun"],
    "working": "Fonctionnement: 'normal' | 'partiel' | 'HS/pour pièces' | 'non précisé'"
  },
  "keyInfo": ["Points importants à retenir (ex: 'batterie HS', 'sans chargeur', 'modèle 2021', 'version 12GB')"],
  "photoVsTextConsistency": "Consistance entre photos et texte: 'cohérent' | 'incohérent' | 'photos manquantes' | 'non déterminable'",
  "confidence": "Ta confiance dans l'identification: 'haute' | 'moyenne' | 'basse'"
}`;

  return `${SYSTEM}

=== ANNONCE À ANALYSER ===
Titre: ${ad.title || '(non précisé)'}
Description:
${desc || '(aucune description)'}

${meta.length > 0 ? 'Données récupérées par le scraper:\n' + meta.join('\n') : '(aucune donnée scraper supplémentaire)'}

${ad.images && ad.images.length > 0 ? `Photos: ${Math.min(ad.images.length, MAX_IMAGES)} photo(s) fournie(s) ci-dessous.` : 'Photos: aucune photo disponible.'}

=== FORMAT DE RÉPONSE ===
Réponds UNIQUEMENT avec ce JSON exact (sans texte autour, sans markdown) :
${jsonSpec}`;
}

/**
 * Télécharge une image et la convertit en base64. Timeout propre couvrant
 * en-têtes + corps, validation du content-type et plafond de taille.
 */
async function downloadImageAsBase64(url, timeoutMs = 8000) {
  // Le signal couvre TOUT le cycle (en-têtes + arrayBuffer). Sinon, une image
  // qui envoie les en-têtes puis bloque le corps pendait indéfiniment.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'image/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);

    // Valide le content-type : une URL d'image peut renvoyer du HTML (page
    // d'erreur 200, redirection de login anti-bot). Base64-encoder du HTML et
    // l'envoyer au modèle vision provoquerait une erreur ou un résultat aberrant.
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) {
      throw new Error(`type MIME non-image ignoré : ${mime || '(absent)'}`);
    }

    // Plafond de taille : une image énorme (ex. 20 Mo) gonfle le base64 à ~27 Mo
    // et peut saturer le contexte Ollama / la mémoire. On ignore au-delà de 5 Mo
    // (l'analyse bascule en texte-seul via allSettled).
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new Error(`image trop volumineuse (${(contentLength / 1048576).toFixed(1)} Mo > ${MAX_IMAGE_BYTES / 1048576} Mo)`);
    }

    const buf = await res.arrayBuffer();
    // Double-vérification sur la taille réelle (content-length peut mentir/absent).
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image trop volumineuse (${(buf.byteLength / 1048576).toFixed(1)} Mo)`);
    }
    const b64 = Buffer.from(buf).toString('base64');
    return { data: b64, mimeType: mime };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`image timeout (${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse la sortie de l'IA (robuste au markdown accidentel).
 * @returns {object|null} null si parsing impossible
 */
function parseAnalysis(rawText) {
  if (!rawText) return null;
  let txt = rawText.trim();
  // retirer un éventuel wrapper ```json ... ```
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // extraire le premier bloc { ... } si l'IA a ajouté du texte autour
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    txt = txt.slice(start, end + 1);
  }
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Fallback minimal quand l'IA échoue : on garde le titre comme identification,
 * sans inventer d'attributs. L'annonce reste exploitable, juste non enrichie.
 */
function fallbackAnalysis(ad, reason) {
  return {
    identifiedProduct: ad.title || 'Produit non identifié',
    summary: 'Analyse IA indisponible. Seules les données brutes de l\'annonce sont disponibles.',
    category: ad.category || null,
    attributes: { brand: null, model: null, condition: null, defects: [], missing: [], accessories: [], working: 'non précisé' },
    keyInfo: [],
    photoVsTextConsistency: 'non déterminable',
    confidence: 'basse',
    _fallback: true,
    _error: reason,
  };
}

class AdAnalyzer {
  /**
   * Analyse une seule annonce (texte + vision).
   * @param {object} ad            l'annonce (doit contenir au moins title)
   * @param {object} aiConfig      config du provider IA { provider, textModel, visionModel, ollamaUrl }
   * @returns {Promise<object>}    résultat d'analyse (toujours défini, fallback si échec)
   */
  static async analyzeAd(ad, aiConfig = {}) {
    if (!ad || !ad.id) throw new Error('AdAnalyzer.analyzeAd: annonce invalide (id requis).');

    // 1. Cache
    const cached = aiCache.get(ad.id, CACHE_PREFIX);
    if (cached && !cached._fallback) return cached;

    const ai = getAIProvider(aiConfig);
    const prompt = buildPrompt(ad);
    const t0 = Date.now();

    // 2. Préparer les images (3 premières)
    const imageUrls = Array.isArray(ad.images) ? ad.images.slice(0, MAX_IMAGES) : [];
    let images = [];
    let visionError = null;
    if (imageUrls.length > 0 && ai.supportsVision() && aiConfig.visionModel) {
      try {
        const downloaded = await Promise.allSettled(
          imageUrls.map((u) => downloadImageAsBase64(u, 15000))
        );
        images = downloaded.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      } catch (err) {
        visionError = err.message;
      }
    }

    // 3. Appel IA (vision si images disponibles, sinon texte)
    let raw;
    try {
      const opts = {
        jsonFormat: true,
        temperature: 0.2,
        timeoutMs: images.length > 0 ? VISION_TIMEOUT_MS : TEXT_TIMEOUT_MS,
      };
      if (aiConfig.visionModel) opts.model = aiConfig.visionModel;

      if (images.length > 0 && ai.supportsVision()) {
        raw = await ai.chatVision(prompt, images, opts);
      } else {
        // dégradation texte (pas d'images OU provider sans vision)
        const textOpts = { ...opts, timeoutMs: TEXT_TIMEOUT_MS };
        if (aiConfig.textModel) textOpts.model = aiConfig.textModel;
        raw = await ai.chatText(prompt, textOpts);
      }
    } catch (err) {
      console.warn(`[AdAnalyzer] IA échouée pour ${ad.id} après ${formatMs(Date.now() - t0)} : ${err.message}`);
      return fallbackAnalysis(ad, `IA indisponible : ${err.message}${visionError ? ` (vision: ${visionError})` : ''}`);
    }

    // 4. Parser
    const parsed = parseAnalysis(raw);
    if (!parsed) {
      console.warn(`[AdAnalyzer] JSON invalide pour ${ad.id} : ${truncate(raw, 100)}`);
      return fallbackAnalysis(ad, 'Réponse IA non interprétable (JSON invalide).');
    }

    // Normaliser les champs tableaux (l'IA peut omettre/omplir mal)
    const a = parsed.attributes || {};
    a.defects = Array.isArray(a.defects) ? a.defects : [];
    a.missing = Array.isArray(a.missing) ? a.missing : [];
    a.accessories = Array.isArray(a.accessories) ? a.accessories : [];
    parsed.attributes = a;
    parsed.keyInfo = Array.isArray(parsed.keyInfo) ? parsed.keyInfo : [];

    aiCache.set(ad.id, parsed, CACHE_PREFIX);
    console.log(`[AdAnalyzer] ${ad.id} analysé en ${formatMs(Date.now() - t0)} → ${truncate(parsed.identifiedProduct || '', 50)}`);
    return parsed;
  }

  /**
   * Analyse un lot d'annonces en parallèle avec cache + progress.
   * @param {Array} ads
   * @param {object} aiConfig
   * @param {object} [opts] { concurrency, onProgress }
   * @returns {Promise<Array>} annonces avec champ adAnalysis ajouté
   */
  static async analyzeAds(ads, aiConfig = {}, opts = {}) {
    const concurrency = Math.max(1, opts.concurrency || 4);
    const onProgress = opts.onProgress || (() => {});
    const total = ads.length;
    let done = 0;

    const queue = [...ads];
    const worker = async () => {
      while (queue.length > 0) {
        const ad = queue.shift();
        if (!ad) break;
        try {
          ad.adAnalysis = await AdAnalyzer.analyzeAd(ad, aiConfig);
        } catch (err) {
          ad.adAnalysis = fallbackAnalysis(ad, err.message);
        }
        done++;
        onProgress({ done, total, percent: Math.round((done / total) * 100), status: `Analyse annonce ${done}/${total}` });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
    onProgress({ done: total, total, percent: 100, status: 'Analyse terminée.' });
    return ads;
  }
}

module.exports = { AdAnalyzer };
