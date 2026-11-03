// ============================================================
// platforms/instagram.js — Instagram via Puppeteer automation
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getBrowser, newPageWithProxy, isPuppeteerAvailable } = require('./browser');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getInstagramCredentials = () => ({
  username: process.env.INSTAGRAM_USERNAME || '',
  password: process.env.INSTAGRAM_PASSWORD || '',
});

const META = {
  id:     'instagram',
  name:   'Instagram',
  icon:   '📸',
  color:  '#e1306c',
  accent: '#e1306c',
  supportsTrending: true,
  credentialFields: [
    { key: 'INSTAGRAM_USERNAME', label: 'Username', type: 'text',     placeholder: 'your_username' },
    { key: 'INSTAGRAM_PASSWORD', label: 'Password', type: 'password', placeholder: '••••••••' },
  ],
};

// ─── Multi-Account Storage & Rotation ────────────────────────
function getAccountsDir() {
  const dir = path.join(__dirname, '..', 'tokens', 'instagram_accounts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAccountsList() {
  const dir = getAccountsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const list = [];

  for (const f of files) {
    try {
      const fullPath = path.join(dir, f);
      const acc = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const stat = fs.statSync(fullPath);
      const cookies = Array.isArray(acc.cookies) ? acc.cookies : [];
      const sessionCookie = cookies.find(c => c.name === 'sessionid');
      let isExpired = acc.status === 'expired';
      if (sessionCookie && sessionCookie.expirationDate) {
        if (Date.now() > sessionCookie.expirationDate * 1000) isExpired = true;
      }

      list.push({
        id: acc.id || f.replace('.json', ''),
        name: acc.name || acc.username || f.replace('.json', ''),
        username: acc.username || '',
        cookieCount: cookies.length,
        hasCredentials: !!(acc.username && acc.password),
        postsCount: acc.postsCount || 0,
        addedAt: acc.addedAt || stat.birthtime.toISOString(),
        lastUsed: acc.lastUsed || stat.mtime.toISOString(),
        valid: !isExpired && (cookies.length > 0 || !!(acc.username && acc.password)),
        expired: isExpired,
        status: isExpired ? 'expired' : 'active',
      });
    } catch {}
  }

  // Also include .env configuration if present and not duplicated
  const envCreds = getInstagramCredentials();
  if (envCreds.username && envCreds.password && !list.some(a => a.username === envCreds.username)) {
    list.unshift({
      id: 'env_default',
      name: `Primary (@${envCreds.username})`,
      username: envCreds.username,
      cookieCount: 0,
      hasCredentials: true,
      postsCount: 0,
      addedAt: new Date().toISOString(),
      lastUsed: null,
      valid: true,
      expired: false,
      status: 'active',
    });
  }

  return list;
}

function saveAccount(name, cookiesData, credentials = {}) {
  let parsedCookies = [];
  if (cookiesData) {
    if (typeof cookiesData === 'string') {
      try { parsedCookies = JSON.parse(cookiesData.trim()); } catch {}
    } else if (Array.isArray(cookiesData)) {
      parsedCookies = cookiesData;
    }
  }

  const safeName = (name || 'Instagram Account').trim();
  const id = 'ig_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const accountData = {
    id,
    name: safeName,
    username: credentials.username || (parsedCookies.find(c => c.name === 'ds_user_id')?.value || ''),
    password: credentials.password || '',
    cookies: parsedCookies,
    postsCount: 0,
    addedAt: new Date().toISOString(),
    lastUsed: null,
    status: 'active',
  };

  const dir = getAccountsDir();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(accountData, null, 2), 'utf8');
  return accountData;
}

function deleteAccount(id) {
  const dir = getAccountsDir();
  const filePath = path.join(dir, `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

let lastAccountIndex = 0;
function getActiveAccount() {
  const dir = getAccountsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    const envCreds = getInstagramCredentials();
    if (envCreds.username && envCreds.password) {
      return { id: 'env_default', name: envCreds.username, username: envCreds.username, password: envCreds.password, cookies: [] };
    }
    return null;
  }

  const list = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.status !== 'expired') list.push(data);
    } catch {}
  }
  if (list.length === 0) return null;

  const acc = list[lastAccountIndex % list.length];
  lastAccountIndex = (lastAccountIndex + 1) % list.length;
  return acc;
}

function recordAccountPost(id) {
  if (!id || id === 'env_default') return;
  const dir = getAccountsDir();
  const filePath = path.join(dir, `${id}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data.postsCount = (data.postsCount || 0) + 1;
      data.lastUsed = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }
}

function isConfigured() {
  const accounts = getAccountsList();
  if (accounts.length > 0 && isPuppeteerAvailable()) return true;
  const { username, password } = getInstagramCredentials();
  return !!(username && password && isPuppeteerAvailable());
}

async function ensureLogin(page, account) {
  const cookies = Array.isArray(account?.cookies) ? account.cookies : [];
  if (cookies.length > 0) {
    const sanitized = cookies.map(c => ({
      name: c.name,
      value: String(c.value),
      domain: c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : '.instagram.com',
      path: c.path || '/',
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
    }));
    await page.setCookie(...sanitized);
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 35000 });
    const loggedIn = await page.evaluate(() => !document.querySelector('a[href*="/accounts/login"]'));
    if (loggedIn) return true;
  }

  // Fallback to username/password login
  const username = account?.username || process.env.INSTAGRAM_USERNAME;
  const password = account?.password || process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) return false;

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 35000 });
  await delay(2000);

  await page.waitForSelector('input[name="username"]', { timeout: 10000 });
  await page.type('input[name="username"]', username, { delay: 50 });
  await page.type('input[name="password"]', password, { delay: 50 });
  await delay(500);

  await page.click('button[type="submit"]');
  await delay(5000);

  // Dismiss prompts
  for (let i = 0; i < 3; i++) {
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const notNow = buttons.find(b => /not now/i.test(b.innerText || ''));
        if (notNow) notNow.click();
      });
      await delay(1200);
    } catch {}
  }

  return !page.url().includes('/accounts/login');
}

async function postComment(postUrl, comment) {
  if (!isConfigured()) throw new Error('Instagram accounts not configured — add an account in the Accounts tab');

  const activeAccount = getActiveAccount();
  const browser = await getBrowser();
  const page = await newPageWithProxy(browser);

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const loggedIn = await ensureLogin(page, activeAccount);
    if (!loggedIn) throw new Error(`Instagram login failed for account "${activeAccount?.name || 'default'}"`);

    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await delay(3000);

    const textareaSelectors = [
      'textarea[placeholder*="comment" i]',
      'textarea[placeholder*="Comment" i]',
      'textarea[aria-label*="comment" i]',
      'textarea',
    ];

    let textarea = null;
    for (const sel of textareaSelectors) {
      textarea = await page.$(sel);
      if (textarea) break;
    }

    if (!textarea) {
      const commentIcon = await page.$('[aria-label*="Comment" i]');
      if (commentIcon) {
        await commentIcon.click();
        await delay(1500);
        for (const sel of textareaSelectors) {
          textarea = await page.$(sel);
          if (textarea) break;
        }
      }
    }

    if (!textarea) throw new Error('Comment textarea not found on Instagram post');

    await textarea.click();
    await delay(500);
    await textarea.type(comment, { delay: 40 });
    await delay(600);

    const postBtn = await page.$('button[type="submit"]:not([disabled])');
    if (postBtn) {
      await postBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await delay(2500);
    recordAccountPost(activeAccount?.id);
    return { success: true, platform: 'instagram', account: activeAccount?.name };
  } finally {
    await page.close();
  }
}

async function testConnection() {
  if (!isPuppeteerAvailable()) return { ok: false, message: 'Puppeteer not installed' };
  const accounts = getAccountsList();
  if (accounts.length > 0) {
    const validCount = accounts.filter(a => a.valid).length;
    return { ok: true, message: `${validCount} active Instagram account(s) ready` };
  }
  return { ok: false, message: 'No Instagram accounts configured — add via Accounts tab or .env' };
}

const INSTAGRAM_COUNTRY_TAGS = {
  IN: ['reelsindia', 'bollywood', 'desi', 'trendinginindia', 'reelsvideo'],
  ID: ['indonesia', 'viralindonesia', 'reelsindonesia', 'dagelan', 'ngakakkocak'],
  US: ['reels', 'viral', 'explorepage', 'trending', 'reelsinstagram'],
  GB: ['uk', 'london', 'viralreels', 'britishmemes'],
  CA: ['canada', 'toronto', 'viralreels'],
  AU: ['australia', 'sydney', 'melbourne'],
  BR: ['brasil', 'reelsbrasil', 'memesbrasil'],
  MX: ['mexico', 'reelsmexico', 'memesmexico'],
  DEFAULT: ['reels', 'viral', 'explorepage', 'trending'],
};

async function getTrending(regionCode = 'US', maxResults = 20) {
  const code = (regionCode || 'US').toUpperCase();
  const tags = INSTAGRAM_COUNTRY_TAGS[code] || INSTAGRAM_COUNTRY_TAGS.DEFAULT;

  return tags.slice(0, maxResults).map((tag, i) => ({
    id: `ig_${code}_${i}`,
    title: `#${tag} — Top Reels & Posts`,
    url: `https://www.instagram.com/explore/tags/${tag}/`,
    thumbnail: 'https://static.cdninstagram.com/rsrc.php/v3/yI/r/VsNE-OHk_8a.png',
    channel: `Instagram Explore • #${tag}`,
    views: '🔥 Trending Tag',
  }));
}

module.exports = {
  ...META,
  isConfigured,
  testConnection,
  postComment,
  getTrending,
  getAccountsList,
  saveAccount,
  deleteAccount,
};
