// ═══════════════════════════════════════════════════════════════════════════
// skilte.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Kommune Dashboard, "Skilte"-fanen (bruger-ønske 2026-08-19) — ren
// genererings-logik for PDF-skilte og QR-EPS-filer. INGEN database/netværk
// her (se logo-fetch.js for selve logo-hentningen, holdt bevidst adskilt
// så DENNE fil kan enhedstestes uden nogen I/O, samme "beregning ren og
// testbar, I/O tyndt og utestet"-grænse resten af repoets *.test.js-filer
// allerede holder).
//
// Adskiller sig fra det EKSISTERENDE, rent klient-side "QR-skilt"
// (generateQrSign(), dansk-overloeb-kort.html) ved at være server-side,
// bulk (ét PDF pr. kommune, alle badesteder), med kommunens eget logo
// øverst, og med QR-koden tegnet som VEKTOR (både i PDF'en og EPS'en) i
// stedet for et rasterbillede hentet fra en ekstern tjeneste.

'use strict';
const QRCode = require('qrcode');

// NYT — QR-modul-matrixen for en given URL. errorCorrectionLevel 'M' (15%
// fejlkorrektion) — samme balance de fleste offentlige QR-skilte bruger:
// robust nok til et udendørs skilt i al slags vejr/lys, uden at gøre
// matrixen unødigt fintmasket.
function buildQrMatrix(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return qr.modules; // { size, data: Uint8Array (size*size, 1=mørkt modul) }
}

const PAGE_W = 595.28, PAGE_H = 841.89; // A4 i punkter (72 dpi) — pdfkit's egen 'A4'-preset

// NYT — tegner de mørke moduler som VEKTOR-rektangler direkte fra
// matrixen, ikke et indlejret rasterbillede — skarpt ved både skærmvisning
// og professionelt tryk.
function drawQrModules(doc, qrMatrix, x, y, sizePt, color) {
  const { size, data } = qrMatrix;
  const moduleSize = sizePt / size;
  doc.fillColor(color);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (data[row * size + col]) {
        doc.rect(x + col * moduleSize, y + row * moduleSize, moduleSize, moduleSize).fill(color);
      }
    }
  }
}

/**
 * Tegner ÉT A4-skilt på en ALLEREDE ÅBEN pdfkit-side — kaldestedet (se
 * server.js's GET /admin/api/skilte/pdf) styrer selv doc.addPage() mellem
 * skilte. Samme visuelle sprog (mørk blå-grøn baggrund, hvid QR-boks,
 * "National Badevandsvarsel"-branding) som det eksisterende klient-side
 * print-skilt, for genkendelighed — porteret til pdfkit's tegne-API i
 * stedet for HTML/CSS, PLUS et kommune-logo øverst (den reelle forskel).
 * @param {PDFKit.PDFDocument} doc
 * @param {{navn: string, url: string, qrMatrix: object, logoBuffer: Buffer|null}} p
 */
function drawSignPage(doc, { navn, url, qrMatrix, logoBuffer }) {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill('#124f68');

  let y = 50;
  if (logoBuffer) {
    try {
      // Kommune-logo øverst, maks 120×50pt (bevarer proportioner via
      // `fit`) — den ENESTE visuelle forskel fra det offentligt
      // tilgængelige skilt.
      doc.image(logoBuffer, (PAGE_W - 120) / 2, y, { fit: [120, 50] });
      y += 65;
    } catch (e) {
      // Ugyldigt/ukendt billedformat — springes over, skiltet skal stadig
      // genereres (samme "vis skiltet alligevel"-filosofi som klientens
      // onerror-fallback for det samme logo_url-felt).
    }
  }

  doc.fillColor('#7fd4e8').fontSize(11).font('Helvetica-Bold')
     .text('NATIONAL BADEVANDSVARSEL · DANMARKS VANDMILJØ', 0, y, { align: 'center', characterSpacing: 1 });
  y += 30;

  doc.fillColor('#ffffff').fontSize(38).font('Helvetica-Bold')
     .text('Dit Badevand Nu', 0, y, { align: 'center' });
  y += 55;

  doc.fillColor('#7fd4e8').fontSize(22).font('Helvetica-Bold')
     .text(navn, 40, y, { align: 'center', width: PAGE_W - 80 });
  y += 45;

  doc.fillColor('#eaf4f8').fontSize(13).font('Helvetica')
     .text('Scan koden for at se den aktuelle risiko for bakterier, virus og alger, inden du hopper i vandet.', 60, y, { align: 'center', width: PAGE_W - 120 });
  y += 70;

  const qrSizePt = 240;
  const qrX = (PAGE_W - qrSizePt) / 2;
  const pad = 20;
  doc.rect(qrX - pad, y - pad, qrSizePt + pad * 2, qrSizePt + pad * 2).fill('#ffffff');
  drawQrModules(doc, qrMatrix, qrX, y, qrSizePt, '#0b2233');
  y += qrSizePt + pad * 2 + 20;

  doc.fillColor('#bcdce6').fontSize(9).font('Courier')
     .text(url, 60, y, { align: 'center', width: PAGE_W - 120 });

  doc.fillColor('#a9cdd9').fontSize(8).font('Helvetica')
     .text('Data for bakterier, virus og alger er beregnede værdier — kun vejledende, ikke en officiel badevandsprofil eller baseret på vandprøver. Læs mere på ditbadevand.dk', 60, PAGE_H - 60, { align: 'center', width: PAGE_W - 120 });
}

/**
 * Ren streng-serialisering til en gyldig, minimal EPS (Encapsulated
 * PostScript) — kun en header + ét `rectfill`-kald pr. mørkt modul.
 * `rectfill` (x y w h rectfill) er en almindelig PostScript Level 2-
 * operator (understøttet af enhver EPS-fortolker/RIP siden tidlige 1990'ere)
 * — en QR-kode er blot et gitter af sorte kvadrater, kræver derfor INTET
 * EPS-bibliotek, kun korrekt PostScript-syntaks.
 * @param {{size:number, data:Uint8Array}} qrMatrix
 * @param {{sizeMm?: number}} opts
 * @returns {string}
 */
function buildQrEps(qrMatrix, { sizeMm = 40 } = {}) {
  const { size, data } = qrMatrix;
  const ptPerMm = 72 / 25.4;
  const totalPt = sizeMm * ptPerMm;
  const moduleSize = totalPt / size;
  const boundingSize = Math.ceil(totalPt);

  const lines = [];
  lines.push('%!PS-Adobe-3.0 EPSF-3.0');
  lines.push(`%%BoundingBox: 0 0 ${boundingSize} ${boundingSize}`);
  lines.push('%%Creator: ditbadevand.dk');
  lines.push('%%Title: QR-kode');
  lines.push('%%EndComments');
  lines.push('0 0 0 setrgbcolor');
  // PostScript/EPS' koordinatsystem har (0,0) i BUNDEN venstre hjørne —
  // matrixens rækkeindeks (0 = ØVERSTE række) skal derfor spejlvendes
  // lodret her, ellers vender QR-koden på hovedet ved udskrift.
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (data[row * size + col]) {
        const px = col * moduleSize;
        const py = totalPt - (row + 1) * moduleSize;
        lines.push(`${px.toFixed(3)} ${py.toFixed(3)} ${moduleSize.toFixed(3)} ${moduleSize.toFixed(3)} rectfill`);
      }
    }
  }
  lines.push('%%EOF');
  return lines.join('\n');
}

module.exports = { buildQrMatrix, drawQrModules, drawSignPage, buildQrEps, PAGE_W, PAGE_H };
