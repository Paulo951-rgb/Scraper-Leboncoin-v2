'use strict';

const fs = require('fs');
const path = require('path');
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
      { header: 'Prix Demande (€)', key: 'price', width: 15 },
      { header: 'Classification Marché', key: 'classification', width: 22 },
      { header: 'Prix Moyen Marché (€)', key: 'marketAvg', width: 20 },
      { header: 'Fourchette Marché (€)', key: 'marketRange', width: 20 },
      { header: 'Écart (€)', key: 'diffEur', width: 12 },
      { header: 'Écart (%)', key: 'diffPct', width: 12 },
      { header: 'Indice Confiance', key: 'confidence', width: 15 },
      { header: 'Résumé Analyse Marché', key: 'summary', width: 45 },
      { header: 'Ville', key: 'city', width: 18 },
      { header: 'Vendeur', key: 'seller', width: 18 },
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

      const row = sheet.addRow({
        id: ad.id || '-',
        title: ad.title || '-',
        price: typeof ad.price === 'number' ? ad.price : parseFloat(ad.price) || 0,
        classification: ma.classification || 'Prix correct',
        marketAvg: ma.marketAvg ? `${ma.marketAvg} €` : '-',
        marketRange: ma.marketMin ? `${ma.marketMin} € - ${ma.marketMax} €` : '-',
        diffEur: ma.diffEur != null ? `${ma.diffEur > 0 ? '+' : ''}${ma.diffEur} €` : '-',
        diffPct: ma.diffPct != null ? `${ma.diffPct > 0 ? '+' : ''}${ma.diffPct} %` : '-',
        confidence: ma.confidence || 'Faible',
        summary: ma.summary || 'Analyse de marché non effectuée',
        city: `${ad.city || '-'}${ad.zipcode ? ' (' + ad.zipcode + ')' : ''}`,
        seller: `${ad.seller || 'Particulier'}${ad.isPro ? ' (Pro)' : ''}`,
        date: ad.date || '-',
        url: { text: 'Ouvrir l\'annonce', hyperlink: ad.url || '#' },
      });

      row.alignment = { vertical: 'middle', wrapText: true };

      const classCell = row.getCell('classification');
      if (ma.classification === 'Très bonne affaire' || ma.classification === 'Bonne affaire') {
        classCell.font = { color: { argb: '15803D' }, bold: true };
      } else if (ma.classification === 'Trop cher') {
        classCell.font = { color: { argb: 'B91C1C' }, bold: true };
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
}

module.exports = { ExcelExporter };