'use strict';

class AiAnalyzer {
  /**
   * Analyse une liste d'annonces via OpenAI GPT ou Ollama Local
   */
  static async analyzeAds(ads, config = {}) {
    const { provider = 'ollama', apiKey, model = 'llama3', ollamaUrl = 'http://127.0.0.1:11434' } = config;

    const enriched = [];

    for (const ad of ads) {
      // Ignorer si déjà analysé ou si pas de texte
      if (ad.aiSummary || (!ad.title && !ad.description)) {
        enriched.push(ad);
        continue;
      }

      try {
        const prompt = `Tu es un expert en analyse d'annonces de seconde main.
Analyse cette annonce Leboncoin :
Titre : ${ad.title || 'Inconnu'}
Prix : ${ad.price || '?'} €
Description : ${ad.description || 'Aucune description'}

Réponds STRICTEMENT sous la forme d'un objet JSON avec cette structure exacte :
{
  "summary": "Résumé concis en 1 phrase maximum",
  "rating": nombre de 1 à 5 (5 = excellente affaire, 1 = mauvais),
  "warnings": "Attention aux détails ou vices cachés détectés (ou Aucun)"
}`;

        let aiResult = null;

        if (provider === 'openai' && apiKey) {
          aiResult = await this._callOpenAi(prompt, apiKey, model);
        } else if (provider === 'ollama') {
          aiResult = await this._callOllama(prompt, ollamaUrl, model);
        }

        if (aiResult) {
          enriched.push({
            ...ad,
            aiSummary: aiResult.summary || null,
            aiRating: aiResult.rating || 3,
            aiWarnings: aiResult.warnings || null,
          });
        } else {
          enriched.push(ad);
        }
      } catch (err) {
        console.error(`Erreur IA sur annonce ${ad.id} :`, err.message);
        enriched.push(ad);
      }
    }

    return enriched;
  }

  static async _callOpenAi(prompt, apiKey, model = 'gpt-4o-mini') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  static async _callOllama(prompt, ollamaUrl, model = 'llama3') {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        prompt: prompt,
        format: 'json',
        stream: false,
      }),
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return JSON.parse(data.response);
  }
}

module.exports = { AiAnalyzer };