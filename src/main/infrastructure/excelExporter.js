'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../utils/helpers');
const ExcelJS = require('exceljs');

class ExcelExporter {
  static async exportToXlsx(ads, outputPath) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Leboncoin Scraper Pro';

    const sheet = workbook.addWorksheet('Annonces Leboncoin', {
      views: [{ showGridLines: true }],
    });

    sheet.columns = [
      { header: 'ID', key: 'id', width: 14 },
      { header: 'Titre de l\'annonce', key: 'title', width: 35 },
      { header: 'Produit Identifié (IA)', key: 'identifiedName', width: 30 },
      { header: 'Prix Demande (€)', key: 'price', width: 15 },
      { header: 'Catégorie', key: 'category', width: 18 },
      { header: 'Verdict IA Marché', key: 'verdictLabel', width: 22 },
      { header: 'Valeur Marché (€)', key: 'marketValue', width: 18 },
      { header: 'Fourchette Marché (€)', key: 'marketRange', width: 20 },
      { header: 'Bénéfice/Perte (€)', key: 'deltaEur', width: 18 },
      { header: 'Résumé IA Analyse', key: 'adSummary', width: 45 },
      { header: 'Justification IA Marché', key: 'maRationale', width: 45 },
      { header: 'Ville', key: 'city', width: 18 },
      { header: 'Vendeur', key: 'seller', width: 18 },
      { header: 'Note Vendeur', key: 'sellerRating', width: 14 },
      { header: 'Mode de Remise', key: 'deliveryMode', width: 18 },
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Lien Leboncoin', key: 'url', width: 30 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '0F172A' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;

    ads.forEach((ad) => {
      const ma = ad.marketAnalysis || {};
      const adAnalysis = ad.adAnalysis || {};

      // Libellé humain pour le mode de remise
      const deliveryLabelMap = {
        livraison: '📦 Livraison',
        main_propre: '🤝 Main propre',
        inconnu: '— Inconnu —',
      };
      const deliveryText = deliveryLabelMap[ad.deliveryMode] || '— Inconnu —';

      // Note vendeur formatée (ex: "4,8/5 (27 avis)")
      let ratingText = '-';
      if (ad.sellerRating != null) {
        ratingText = `${String(ad.sellerRating).replace('.', ',')}/5`;
        if (ad.sellerRatingCount != null) ratingText += ` (${ad.sellerRatingCount} avis)`;
      }

      // Date lisible : Leboncoin renvoie une ISO (ex: 2024-01-15T10:30:00+00:00).
      // On formate en JJ/MM/AAAA HH:mm pour l'export, en gardant '-' si absente/
      // invalide (Date invalide → NaN, vérifié via Number.isFinite).
      let dateText = '-';
      if (ad.date) {
        const d = new Date(ad.date);
        if (Number.isFinite(d.getTime())) {
          const pad = (n) => String(n).padStart(2, '0');
          dateText = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      }

      const row = sheet.addRow({
        id: ad.id || '-',
        title: ad.title || '-',
        identifiedName: adAnalysis.identifiedProduct || '-',
        price: typeof ad.price === 'number' ? ad.price : parseFloat(ad.price) || 0,
        category: ad.category || '-',
        verdictLabel: ma.verdictLabel || 'Non analysé',
        marketValue: ma.realValue != null ? `${ma.realValue} €` : '-',
        marketRange: (ma.valueRangeLow != null && ma.valueRangeHigh != null) ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '-',
        deltaEur: ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '-',
        adSummary: adAnalysis.summary || 'Analyse IA non effectuée',
        maRationale: ma.rationale || '-',
        city: `${ad.city || '-'}${ad.zipcode ? ' (' + ad.zipcode + ')' : ''}`,
        seller: `${ad.seller || 'Particulier'}${ad.isPro ? ' (Pro)' : ''}`,
        sellerRating: ratingText,
        deliveryMode: deliveryText,
        date: dateText,
        url: { text: 'Ouvrir l\'annonce', hyperlink: ad.url || '#' },
      });

      row.alignment = { vertical: 'middle', wrapText: true };

      const verdictCell = row.getCell('verdictLabel');
      if (ma.verdictLabel === 'Très bonne affaire' || ma.verdictLabel === 'Bonne affaire') {
        verdictCell.font = { color: { argb: '15803D' }, bold: true };
      } else if (ma.verdictLabel === 'Trop cher' || ma.verdictLabel === 'Très cher') {
        verdictCell.font = { color: { argb: 'B91C1C' }, bold: true };
      }

      const urlCell = row.getCell('url');
      urlCell.font = { color: { argb: '0284C7' }, underline: true };
    });

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    await workbook.xlsx.writeFile(outputPath);

    return outputPath;
  }

  /**
   * Échappe une valeur pour un champ CSV conforme RFC 4180 :
   * entourer de guillemets si la valeur contient un séparateur, un guillemet,
   * un retour à la ligne ; et doubler les guillemets internes.
   */
  static _csvField(value, sep = ';') {
    const s = value == null ? '' : String(value);
    if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  /**
   * Exporte les annonces au format CSV (compatible Excel FR : séparateur « ; »,
   * encodage UTF-8 avec BOM pour que les accents s'affichent correctement à
   * l'ouverture dans Excel). Représente les mêmes colonnes que le .xlsx, en
   * version texte plat. Utile pour un import dans un tableur alternatif ou un
   * script.
   * @returns {string} chemin du fichier écrit.
   */
  static async exportToCsv(ads, outputPath) {
    const sep = ';';
    const headers = [
      'ID', 'Titre', 'Produit Identifié (IA)', 'Prix (€)', 'Catégorie',
      'Verdict IA Marché', 'Valeur Marché (€)', 'Fourchette Marché (€)',
      'Bénéfice/Perte (€)', 'Résumé IA', 'Justification Marché',
      'Ville', 'Vendeur', 'Note Vendeur', 'Remise', 'Date', 'Lien',
    ];

    const rows = [headers.map((h) => this._csvField(h, sep)).join(sep)];

    for (const ad of ads) {
      const ma = ad.marketAnalysis || {};
      const aa = ad.adAnalysis || {};
      const deliveryMap = { livraison: 'Livraison', main_propre: 'Main propre', inconnu: 'Inconnu' };
      let rating = '';
      if (ad.sellerRating != null) {
        rating = `${String(ad.sellerRating).replace('.', ',')}/5`;
        if (ad.sellerRatingCount != null) rating += ` (${ad.sellerRatingCount} avis)`;
      }
      let dateText = '';
      if (ad.date) {
        const d = new Date(ad.date);
        if (Number.isFinite(d.getTime())) {
          const pad = (n) => String(n).padStart(2, '0');
          dateText = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      }
      const marketRange = (ma.valueRangeLow != null && ma.valueRangeHigh != null)
        ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '';
      const delta = ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '';

      const row = [
        ad.id || '',
        ad.title || '',
        aa.identifiedProduct || '',
        typeof ad.price === 'number' ? String(ad.price).replace('.', ',') : (ad.price || ''),
        ad.category || '',
        ma.verdictLabel || '',
        ma.realValue != null ? `${ma.realValue} €` : '',
        marketRange,
        delta,
        aa.summary || '',
        ma.rationale || '',
        `${ad.city || ''}${ad.zipcode ? ' (' + ad.zipcode + ')' : ''}`,
        `${ad.seller || 'Particulier'}${ad.isPro ? ' (Pro)' : ''}`,
        rating,
        deliveryMap[ad.deliveryMode] || 'Inconnu',
        dateText,
        ad.url || '',
      ];
      rows.push(row.map((v) => this._csvField(v, sep)).join(sep));
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    // BOM UTF-8 (\uFEFF) : indispensable pour qu'Excel Windows reconnaisse
    // l'UTF-8 et affiche correctement les accents.
    atomicWriteFileSync(outputPath, '\uFEFF' + rows.join('\r\n'));
    return outputPath;
  }
}

module.exports = { ExcelExporter };