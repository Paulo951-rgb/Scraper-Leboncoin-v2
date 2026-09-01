'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('../utils/helpers');
const ExcelJS = require('exceljs');

/**
 * Extracteur de description sûr : garantit qu'on n'envoie JAMAIS un objet
 * au writer XLSX/CSV (sinon Excel/CSV écrirait [object Object]).
 * Renvoie TOUJOURS une string (ou '' si absente).
 */
function _descString(ad) {
  if (typeof ad.description === 'string') return ad.description;
  if (ad && typeof ad.description === 'object' && typeof ad.description.originale === 'string') {
    return ad.description.originale;
  }
  return '';
}

class ExcelExporter {
  static async exportToXlsx(ads, outputPath) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Leboncoin Scraper Pro';

    const sheet = workbook.addWorksheet('Annonces Leboncoin', {
      views: [{ showGridLines: true }],
    });

    sheet.columns = [
      { header: 'ID', key: 'id', width: 14 },
      { header: 'Titre', key: 'title', width: 35 },
      { header: 'Produit Identifié (IA)', key: 'identifiedName', width: 30 },
      { header: 'Prix (€)', key: 'price', width: 12 },
      { header: 'Ville', key: 'city', width: 16 },
      { header: 'Code Postal', key: 'zipcode', width: 10 },
      { header: 'Vendeur', key: 'vendeurNom', width: 16 },
      { header: 'Type Vendeur', key: 'vendeurType', width: 12 },
      { header: 'ID Vendeur', key: 'vendeurId', width: 14 },
      { header: 'Note Vendeur', key: 'vendeurNote', width: 14 },
      { header: 'URL Profil', key: 'vendeurUrlProfil', width: 14 },
      { header: 'Ancienneté (jours)', key: 'vendeurAncienneteJours', width: 14 },
      { header: 'Livraison', key: 'livraison', width: 10 },
      { header: 'Main Propre', key: 'mainPropre', width: 10 },
      { header: 'Likes', key: 'likes', width: 8 },
      { header: 'État', key: 'etat', width: 14 },
      { header: 'Nb Photos', key: 'photosCount', width: 9 },
      { header: 'Description', key: 'description', width: 50 },
      { header: 'Verdict IA Marché', key: 'verdictLabel', width: 20 },
      { header: 'Valeur Marché (€)', key: 'marketValue', width: 14 },
      { header: 'Fourchette Marché (€)', key: 'marketRange', width: 20 },
      { header: 'Bénéfice/Perte (€)', key: 'deltaEur', width: 14 },
      { header: 'Résumé IA Analyse', key: 'adSummary', width: 40 },
      { header: 'Justification IA Marché', key: 'maRationale', width: 40 },
      { header: 'Date Publication', key: 'datePublication', width: 20 },
      { header: 'Date Modification', key: 'dateModification', width: 20 },
      { header: 'Date Scraping', key: 'dateScraping', width: 20 },
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

      const livraison = ad.livraison === true ? 'OUI' : (ad.livraison === false ? 'NON' : '');
      const mainPropre = ad.mainPropre === true ? 'OUI' : (ad.mainPropre === false ? 'NON' : '');

      let ratingText = '';
      if (ad.vendeurNote != null) {
        ratingText = `${String(ad.vendeurNote).replace('.', ',')}/5`;
      }

      const fmtDate = (val) => {
        if (!val) return '';
        const d = new Date(val);
        if (!Number.isFinite(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      const row = sheet.addRow({
        id: ad.id || '',
        title: ad.title || '',
        identifiedName: adAnalysis.identifiedProduct || '',
        price: ad.prix != null ? ad.prix : '',
        city: ad.city || '',
        zipcode: ad.zipcode || '',
        vendeurNom: ad.vendeurNom || '',
        vendeurType: ad.vendeurType || '',
        vendeurId: ad.vendeurId || '',
        vendeurNote: ratingText,
        vendeurUrlProfil: ad.vendeurUrlProfil || '',
        vendeurAncienneteJours: ad.vendeurAncienneteJours != null ? ad.vendeurAncienneteJours : '',
        livraison,
        mainPropre,
        likes: ad.likes != null ? ad.likes : '',
        etat: ad.etat || '',
        photosCount: ad.photosCount != null ? ad.photosCount : '',
        description: _descString(ad),
        verdictLabel: ma.verdictLabel || '',
        marketValue: ma.realValue != null ? `${ma.realValue} €` : '',
        marketRange: (ma.valueRangeLow != null && ma.valueRangeHigh != null) ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '',
        deltaEur: ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '',
        adSummary: adAnalysis.summary || '',
        maRationale: ma.rationale || '',
        datePublication: fmtDate(ad.datePublication),
        dateModification: fmtDate(ad.dateModification),
        dateScraping: fmtDate(ad.dateScraping),
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

  static _csvField(value, sep = ';') {
    const s = value == null ? '' : String(value);
    if (s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  static async exportToCsv(ads, outputPath) {
    const sep = ';';
    const headers = [
      'ID', 'Titre', 'Produit Identifié (IA)', 'Prix (€)',
      'Ville', 'Code Postal',
      'Vendeur', 'Type Vendeur', 'ID Vendeur', 'Note Vendeur', 'URL Profil', 'Ancienneté (jours)',
      'Livraison', 'Main Propre', 'Likes',
      'État', 'Nb Photos', 'Description',
      'Verdict IA Marché', 'Valeur Marché (€)', 'Fourchette Marché (€)', 'Bénéfice/Perte (€)',
      'Résumé IA', 'Justification Marché',
      'Date Publication', 'Date Modification', 'Date Scraping',
      'Lien',
    ];

    const rows = [headers.map((h) => this._csvField(h, sep)).join(sep)];

    const fmtDate = (val) => {
      if (!val) return '';
      const d = new Date(val);
      if (!Number.isFinite(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const fmtTri = (v) => v === true ? 'OUI' : (v === false ? 'NON' : '');

    for (const ad of ads) {
      const ma = ad.marketAnalysis || {};
      const aa = ad.adAnalysis || {};

      let rating = '';
      if (ad.vendeurNote != null) {
        rating = `${String(ad.vendeurNote).replace('.', ',')}/5`;
      }

      const marketRange = (ma.valueRangeLow != null && ma.valueRangeHigh != null)
        ? `${ma.valueRangeLow} € - ${ma.valueRangeHigh} €` : '';
      const delta = ma.deltaEur != null ? `${ma.deltaEur > 0 ? '+' : ''}${ma.deltaEur} €` : '';
      const descriptionStr = _descString(ad);

      const row = [
        ad.id || '',
        ad.title || '',
        aa.identifiedProduct || '',
        ad.prix != null ? String(ad.prix).replace('.', ',') : '',
        ad.city || '',
        ad.zipcode || '',
        ad.vendeurNom || '',
        ad.vendeurType || '',
        ad.vendeurId || '',
        rating,
        ad.vendeurUrlProfil || '',
        ad.vendeurAncienneteJours != null ? String(ad.vendeurAncienneteJours) : '',
        fmtTri(ad.livraison),
        fmtTri(ad.mainPropre),
        ad.likes != null ? String(ad.likes) : '',
        ad.etat || '',
        ad.photosCount != null ? String(ad.photosCount) : '',
        descriptionStr,
        ma.verdictLabel || '',
        ma.realValue != null ? `${ma.realValue} €` : '',
        marketRange,
        delta,
        aa.summary || '',
        ma.rationale || '',
        fmtDate(ad.datePublication),
        fmtDate(ad.dateModification),
        fmtDate(ad.dateScraping),
        ad.url || '',
      ];
      rows.push(row.map((v) => this._csvField(v, sep)).join(sep));
    }

    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(outputPath, '\uFEFF' + rows.join('\r\n'));
    return outputPath;
  }
}

module.exports = { ExcelExporter };
