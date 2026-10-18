'use strict';

/**
 * Liste de User-Agents réalistes (Chrome sur Windows/Mac/Linux).
 *
 * IMPORTANT — cohérence de version : les UA historiques annonçaient Chrome
 * 122..125 alors que le moteur embarqué est Chromium bien plus récent. Un
 * « navigator.userAgent » en retard sur le comportement réel du moteur est un
 * signal anti-bot simple à détecter (CloudFront bot-control, Arkose). On aligne
 * donc la version annoncée sur la version MAJEURE réelle du Chromium embarqué
 * (lue depuis playwright-core/browsers.json), avec repli sûr si indisponible.
 */
const { resolveChromiumMajorVersion } = require('./stealthProfile');

const CHROME_MAJOR = resolveChromiumMajorVersion() || '125';

// Variantes par PLATEFORME (toutes cohérentes avec les client hints Chrome du
// profil : mêmes marques, même version majeure). Aucune variante Edge/Brave
// (elle contredirait Sec-CH-UA « Google Chrome »).
const USER_AGENTS = [
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

module.exports = { USER_AGENTS, getRandomUserAgent, CHROME_MAJOR };
