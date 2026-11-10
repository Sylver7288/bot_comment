// ============================================================
// platforms/instagram.js — Instagram via Puppeteer automation
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getBrowser, newPageWithProxy, isPuppeteerAvailable, getDefaultUserAgent } = require('./browser');

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
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCookies').catch(() => {});
      const cdpCookies = cookies.map(c => ({
        name: c.name,
        value: String(c.value),
        domain: c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : '.instagram.com',
        path: c.path || '/',
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
      }));
      await client.send('Network.setCookies', { cookies: cdpCookies });
      console.log(`🍪 Applied ${cdpCookies.length} Instagram cookies for [${account?.name || 'Account'}] via CDP`);
    } catch (cdpErr) {
      console.warn('⚠️ CDP cookie set failed, falling back to page.setCookie:', cdpErr.message);
      const sanitized = cookies.map(c => ({
        name: c.name,
        value: String(c.value),
        domain: c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : '.instagram.com',
        path: c.path || '/',
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
      }));
      await page.setCookie(...sanitized).catch(() => {});
    }

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await delay(2500);

    // Dismiss notifications/cookie dialogs if any
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of btns) {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (t === 'not now' || t === 'allow all cookies' || t === 'accept all' || t === 'decline optional cookies') {
            b.click();
            break;
          }
        }
      });
    } catch {}

    const loggedIn = await page.evaluate(() => {
      const hasLoginInput = !!document.querySelector('input[name="username"]');
      const hasProfileIcon = !!document.querySelector('svg[aria-label="Profile"], svg[aria-label="Home"], a[href*="/direct/inbox"], img[data-testid="user-avatar"]');
      return !hasLoginInput || hasProfileIcon;
    });
    if (loggedIn) return true;
  }

  // Fallback to username/password login
  const username = account?.username || process.env.INSTAGRAM_USERNAME;
  const password = account?.password || process.env.INSTAGRAM_PASSWORD;
  if (!username || !password) return false;

  console.log(`🔑 Attempting Instagram password login for @${username}...`);
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 35000 });
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
    await page.setViewport({ width: 1440, height: 900 }).catch(() => {});
    await page.setUserAgent(getDefaultUserAgent());

    const loggedIn = await ensureLogin(page, activeAccount);
    if (!loggedIn) throw new Error(`Instagram login failed for account "${activeAccount?.name || 'default'}"`);

    // Clean URL
    let cleanUrl = postUrl.trim();
    if (cleanUrl.includes('instagram.com') && cleanUrl.includes('?')) {
      cleanUrl = cleanUrl.split('?')[0];
    }

    console.log(`🌐 Loading Instagram post: ${cleanUrl}`);
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await delay(3000);

    // Dismiss cookie/notification modals
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of btns) {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          if (t === 'not now' || t === 'allow all cookies' || t === 'accept all' || t === 'decline optional cookies') {
            b.click();
            break;
          }
        }
      });
    } catch {}

    const commentInputSelectors = [
      'textarea[aria-label*="comment" i]',
      'textarea[placeholder*="comment" i]',
      'form textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label*="comment" i]',
      'div[contenteditable="true"]',
      'textarea',
    ];

    let inputEl = null;
    for (const sel of commentInputSelectors) {
      inputEl = await page.$(sel);
      if (inputEl) break;
    }

    if (!inputEl) {
      console.log('🔍 Comment box not immediately visible — clicking Comment icon to open drawer...');
      const commentIcon = await page.$('[aria-label*="Comment" i], svg[aria-label*="Comment" i]');
      if (commentIcon) {
        await commentIcon.click();
        await delay(2000);
        for (const sel of commentInputSelectors) {
          inputEl = await page.$(sel);
          if (inputEl) break;
        }
      }
    }

    if (!inputEl) throw new Error('Comment box not found on Instagram post (post may have comments turned off)');

    console.log(`💬 Typing Instagram comment: "${comment.substring(0, 45)}..."`);
    await inputEl.click();
    await delay(400);
    await page.keyboard.type(comment, { delay: 35 });
    await delay(800);

    // Submit via Post button or Enter
    const submitted = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('form button, div[role="button"]'));
      const postBtn = btns.find(b => {
        const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
        return t === 'post' || t === 'submit' || t === 'send';
      });
      if (postBtn && !postBtn.disabled) {
        postBtn.click();
        return true;
      }
      return false;
    });

    if (!submitted) {
      console.log('🚀 Pressing Enter to submit comment...');
      await page.keyboard.press('Enter');
    }

    await delay(4000);

    // Proof screenshot
    try {
      const proofPath = path.join(__dirname, '..', 'public', 'instagram_last_post.png');
      await page.screenshot({ path: proofPath });
      console.log('📸 Saved Instagram proof screenshot to public/instagram_last_post.png');
    } catch {}

    recordAccountPost(activeAccount?.id);
    return { success: true, platform: 'instagram', account: activeAccount?.name, url: cleanUrl };
  } catch (err) {
    try {
      const errPath = path.join(__dirname, '..', 'public', 'instagram_last_error.png');
      await page.screenshot({ path: errPath });
      console.warn('📸 Saved Instagram error screenshot to public/instagram_last_error.png');
    } catch {}
    throw err;
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
