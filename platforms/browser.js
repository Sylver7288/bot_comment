// ============================================================
// platforms/browser.js — Shared Puppeteer browser manager
// ============================================================
let puppeteer;

try {
  puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());
  console.log('✅ Puppeteer loaded with stealth plugin');
} catch {
  try {
    puppeteer = require('puppeteer');
    console.log('✅ Puppeteer loaded (no stealth plugin)');
  } catch {
    puppeteer = null;
    console.warn('⚠️ Puppeteer not installed — TikTok/Instagram disabled');
  }
}

let browser = null;
let lastUsed = 0;
let currentProxyKey = '';
const IDLE_TIMEOUT = 10 * 60 * 1000; // close after 10 min idle

async function getBrowser() {
  if (!puppeteer) throw new Error('Puppeteer not installed. Run: npm install puppeteer');

  const proxyKey = `${process.env.PROXYLAB_ENABLED}:${process.env.PROXYLAB_HOST}:${process.env.PROXYLAB_PORT}:${process.env.PROXYLAB_USERNAME}`;

  if (browser) {
    try {
      if (currentProxyKey !== proxyKey) {
        console.log('🔄 Proxy settings changed — restarting browser with new proxy...');
        await browser.close().catch(() => {});
        browser = null;
      } else if (browser.isConnected() && (Date.now() - lastUsed) < IDLE_TIMEOUT) {
        lastUsed = Date.now();
        return browser;
      }
    } catch {}
    try { await browser.close(); } catch {}
    browser = null;
  }

  currentProxyKey = proxyKey;

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--window-size=1280,800',
  ];

  // If proxy is enabled in .env, route Puppeteer through proxy (vital for TikTok in restricted regions like India)
  if (process.env.PROXYLAB_ENABLED === 'true' && process.env.PROXYLAB_HOST) {
    const port = process.env.PROXYLAB_PORT || '8080';
    args.push(`--proxy-server=http://${process.env.PROXYLAB_HOST}:${port}`);
    console.log(`🛡️ Puppeteer using proxy: ${process.env.PROXYLAB_HOST}:${port}`);
  }

  const isHeadless = process.env.PUPPETEER_HEADLESS !== 'false';
  browser = await puppeteer.launch({
    headless: isHeadless,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: { width: 1280, height: 800 },
  });

  lastUsed = Date.now();
  return browser;
}

async function newPageWithProxy(browserInstance) {
  const page = await browserInstance.newPage();
  if (process.env.PROXYLAB_ENABLED === 'true' && process.env.PROXYLAB_USERNAME && process.env.PROXYLAB_PASSWORD) {
    await page.authenticate({
      username: (process.env.PROXYLAB_USERNAME || '').trim(),
      password: (process.env.PROXYLAB_PASSWORD || '').trim(),
    });
  }
  return page;
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

function isPuppeteerAvailable() {
  return puppeteer !== null;
}

module.exports = { getBrowser, newPageWithProxy, closeBrowser, isPuppeteerAvailable };
