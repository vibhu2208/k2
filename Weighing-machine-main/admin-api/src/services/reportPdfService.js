'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isConfigured,
  getObjectBuffer,
  putObject,
  mirrorReportKey,
  presignGet,
} = require('./s3Presign');
const { getSiteId } = require('../db');
const {
  buildVehicleReportHtml,
  bufferToDataUrl,
} = require('./vehicleReportHtml');
const { hydratePhotoKeys } = require('./reportMedia');

const PHOTO_FIELDS = [
  { col: 'arrival_photo_1', pass: 'arrival', slot: 1 },
  { col: 'arrival_photo_2', pass: 'arrival', slot: 2 },
  { col: 'arrival_photo_3', pass: 'arrival', slot: 3 },
  { col: 'departure_photo_1', pass: 'departure', slot: 1 },
  { col: 'departure_photo_2', pass: 'departure', slot: 2 },
  { col: 'departure_photo_3', pass: 'departure', slot: 3 },
];

const PDF_PHOTO_MAX_WIDTH = Number(process.env.PDF_PHOTO_MAX_WIDTH) || 480;
const PDF_PHOTO_JPEG_QUALITY = Number(process.env.PDF_PHOTO_JPEG_QUALITY) || 55;

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

let sharedBrowser = null;
let sharedBrowserLaunch = null;
let pdfQueue = Promise.resolve();

/** PC slips print "WB - 04"; env/site id may be "WB-04" or "WB04". */
function formatWeighbridgeId(raw, siteId) {
  const source = String(raw || siteId || '').trim();
  const m = source.match(/^([A-Za-z]+)\s*-?\s*(\d+)$/);
  if (m) return `${m[1].toUpperCase()} - ${m[2].padStart(2, '0')}`;
  return source || 'WB - 03';
}

function companySettings() {
  const siteId = getSiteId();
  return {
    name: process.env.COMPANY_NAME || 'MUNICIPAL CORPORATION GURUGRAM',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    siteName:
      process.env.SITE_NAME ||
      process.env.COMPANY_ADDRESS ||
      'BANDHWARI SLF SITE GURURAM (HARYANA)',
    weighbridgeId: formatWeighbridgeId(process.env.WEIGHBRIDGE_ID, siteId),
    reportCompanyName: process.env.REPORT_COMPANY_NAME || 'MKG GREEN ENERGY',
    logoPath: process.env.REPORT_LOGO_PATH || '',
  };
}

function ensureTempDir() {
  const dir = path.join(os.tmpdir(), 'weighbridge-admin-pdf');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function compressPhotoForPdf(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return buf;
  if (!sharp) return buf;
  try {
    return await sharp(buf, {
      failOn: 'error',
      limitInputPixels: Number(process.env.MAX_UPLOAD_INPUT_PIXELS) || 40_000_000,
    })
      .rotate()
      .resize({
        width: PDF_PHOTO_MAX_WIDTH,
        withoutEnlargement: true,
      })
      .jpeg({ quality: PDF_PHOTO_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn('[reportPdf] photo compress failed', err.message);
    return null;
  }
}

async function loadPhotoDataUrls(row) {
  const photos = {
    arrival: [null, null, null],
    departure: [null, null, null],
  };
  if (!isConfigured()) return photos;

  // Resolve missing/stale keys the same way the edit UI does.
  const hydrated = await hydratePhotoKeys(row);

  await Promise.all(
    PHOTO_FIELDS.map(async ({ col, pass, slot }) => {
      const key = hydrated[col];
      if (!key) return;
      try {
        const buf = await getObjectBuffer(key);
        if (!buf) return;
        const compressed = await compressPhotoForPdf(buf);
        if (!compressed) return;
        const src = bufferToDataUrl(compressed, 'image/jpeg');
        if (src) photos[pass][slot - 1] = src;
      } catch (err) {
        console.warn('[reportPdf] photo download failed', col, err.message);
      }
    }),
  );
  return photos;
}

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;
  if (sharedBrowserLaunch) return sharedBrowserLaunch;

  const puppeteer = require('puppeteer');
  sharedBrowserLaunch = puppeteer
    .launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })
    .then((browser) => {
      sharedBrowser = browser;
      sharedBrowserLaunch = null;
      browser.on('disconnected', () => {
        sharedBrowser = null;
      });
      return browser;
    })
    .catch((err) => {
      sharedBrowserLaunch = null;
      throw err;
    });

  return sharedBrowserLaunch;
}

async function renderHtmlToPdfBuffer(html) {
  const tempDir = ensureTempDir();
  const tempHtml = path.join(
    tempDir,
    `render_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}.html`,
  );
  fs.writeFileSync(tempHtml, html, 'utf8');

  const run = async () => {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    try {
      await page.goto(`file://${tempHtml}`, {
        waitUntil: 'networkidle0',
        timeout: 60000,
      });
      await page.evaluate(async () => {
        const imgs = Array.from(document.images || []);
        await Promise.all(
          imgs.map(
            (img) =>
              new Promise((resolve) => {
                const finish = () => {
                  if (img.naturalWidth === 0) {
                    img.style.display = 'none';
                    const parent = img.closest('.photo-cell');
                    if (parent) parent.classList.add('empty');
                  }
                  resolve();
                };
                if (img.complete) finish();
                else {
                  img.addEventListener('load', finish, { once: true });
                  img.addEventListener('error', finish, { once: true });
                }
              }),
          ),
        );
      });
      await new Promise((r) => setTimeout(r, 150));

      const pdf = await page.pdf({
        printBackground: true,
        width: '8.27in',
        height: '11.69in',
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        preferCSSPageSize: true,
      });
      return Buffer.from(pdf);
    } finally {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // Serialize PDF jobs on the shared Chromium to avoid OOM.
    const resultPromise = pdfQueue.then(run, run);
    pdfQueue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return await resultPromise;
  } finally {
    try {
      fs.unlinkSync(tempHtml);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build a slip PDF matching the weighbridge PC layout (same HTML/CSS).
 */
async function generateTripPdf(row, options = {}) {
  if (!row?.slip_number) throw new Error('Trip row with slip_number is required');

  const photoDataUrls = await loadPhotoDataUrls(row);
  const html = buildVehicleReportHtml(
    {
      ...row,
      company: row.company || 'MKG GREEN ENERGY',
      ticket_status: row.ticket_status || 'CLOSED',
      print_at: options.printAt || row.print_at || undefined,
    },
    companySettings(),
    photoDataUrls,
  );
  const pdf = await renderHtmlToPdfBuffer(html);

  let reportS3Key = null;
  let reportUrl = null;
  if (options.upload !== false && isConfigured()) {
    const siteId = options.siteId || getSiteId();
    reportS3Key = mirrorReportKey(siteId, row.slip_number);
    await putObject(reportS3Key, pdf, 'application/pdf');
    reportUrl = await presignGet(reportS3Key);
  }

  return {
    pdf,
    report_s3_key: reportS3Key,
    report_url: reportUrl,
    slip_number: row.slip_number,
    filename: `${row.slip_number}_report.pdf`,
  };
}

module.exports = {
  generateTripPdf,
  PHOTO_FIELDS,
};
