// Convert an image to PNG using Chromium (handles webp).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [src, dst] = process.argv.slice(2);
const b64 = readFileSync(src).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
const page = await browser.newPage();
const dataUrl = `data:image/webp;base64,${b64}`;
const png = await page.evaluate(async (dataUrl) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}, dataUrl);
writeFileSync(dst, Buffer.from(png, 'base64'));
console.log('wrote', dst);
await browser.close();
