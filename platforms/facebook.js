// ============================================================
// platforms/facebook.js — Facebook via Puppeteer automation & Cookies
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getBrowser, newPageWithProxy, isPuppeteerAvailable } = require('./browser');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const META = {
  id:     'facebook',
  name:   'Facebook',
  icon:   '📘',
  color:  '#1877f2',
  accent: '#1877f2',
  supportsTrending: true,
  credentialFields: [
    { key: 'FACEBOOK_EMAIL',    label: 'Email / Phone (Optional)', type: 'text',     placeholder: 'user@example.com' },
    { key: 'FACEBOOK_PASSWORD', label: 'Password (Optional)',      type: 'password', placeholder: '••••••••' },
  ],
};

let lastCookieError = null;

function getCookieFile() {
  return path.join(__dirname, '..', 'tokens', 'facebook_cookies.json');
}

function getAccountsDir() {
  const dir = path.join(__dirname, '..', 'tokens', 'facebook_accounts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function initAccounts() {
  const dir = getAccountsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    const legacyFile = getCookieFile();
    if (fs.existsSync(legacyFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        if (Array.isArray(raw) && raw.length > 0) {
          const accId = 'acc_default';
          const cUser = raw.find(c => c.name === 'c_user');
          const accData = {
            id: accId,
            name: cUser ? `Account (${cUser.value})` : 'Facebook Account 1',
            username: cUser ? cUser.value : '',
            cookies: raw,
            postsCount: 0,
            addedAt: new Date().toISOString(),
            lastUsed: null,
            status: 'active'
          };
          fs.writeFileSync(path.join(dir, `${accId}.json`), JSON.stringify(accData, null, 2), 'utf8');
        }
      } catch {}
    }
  }
}

try { initAccounts(); } catch {}

function getAccountsList() {
  try { initAccounts(); } catch {}
  const dir = getAccountsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const list = [];
  for (const f of files) {
    try {
      const fullPath = path.join(dir, f);
      const acc = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const stat = fs.statSync(fullPath);
      const cookies = Array.isArray(acc.cookies) ? acc.cookies : [];
      const hasAuth = cookies.some(c => c.name === 'c_user' || c.name === 'xs');
      const isExpired = acc.status === 'expired' || !hasAuth;
      list.push({
        id: acc.id || f.replace('.json', ''),
        name: acc.name || 'Facebook Account',
        username: acc.username || '',
        cookieCount: cookies.length,
        postsCount: acc.postsCount || 0,
        addedAt: acc.addedAt || stat.birthtime.toISOString(),
        lastUsed: acc.lastUsed || stat.mtime.toISOString(),
        valid: !isExpired && cookies.length > 0,
        expired: isExpired,
        status: isExpired ? 'expired' : 'active',
        reason: acc.lastError || (isExpired ? 'Session expired or missing c_user' : 'Active'),
      });
    } catch {}
  }
  return list;
}

function saveAccount(name, cookiesData) {
  let parsed;
  if (typeof cookiesData === 'string') {
    parsed = JSON.parse(cookiesData.trim());
  } else {
    parsed = cookiesData;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Invalid cookies format — must be a JSON array of cookie objects from Cookie-Editor');
  }

  const dir = getAccountsDir();
  const id = 'acc_' + Date.now();
  const cUser = parsed.find(c => c.name === 'c_user');
  const count = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  const cleanName = (name || '').trim() || (cUser ? `Account (${cUser.value})` : `Facebook Account ${count + 1}`);

  const accData = {
    id,
    name: cleanName,
    username: cUser ? cUser.value : '',
    cookies: parsed,
    postsCount: 0,
    addedAt: new Date().toISOString(),
    lastUsed: null,
    status: 'active'
  };

  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(accData, null, 2), 'utf8');

  try {
    fs.writeFileSync(getCookieFile(), JSON.stringify(parsed, null, 2), 'utf8');
  } catch {}

  return {
    id,
    name: cleanName,
    cookieCount: parsed.length,
    valid: true,
    status: 'active'
  };
}

function deleteAccount(id) {
  const dir = getAccountsDir();
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

let currentAccountIndex = 0;

function getNextAccount() {
  try { initAccounts(); } catch {}
  const dir = getAccountsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    const legacy = loadSavedCookies();
    if (legacy && legacy.length > 0) {
      return { id: 'legacy', name: 'Default Account', cookies: legacy };
    }
    return null;
  }

  const accounts = [];
  for (const f of files) {
    try {
      const acc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (acc && Array.isArray(acc.cookies) && acc.cookies.length > 0) {
        accounts.push(acc);
      }
    } catch {}
  }

  if (accounts.length === 0) return null;
  const account = accounts[currentAccountIndex % accounts.length];
  currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
  return account;
}

function recordAccountPostSuccess(id) {
  const dir = getAccountsDir();
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    try {
      const acc = JSON.parse(fs.readFileSync(file, 'utf8'));
      acc.postsCount = (acc.postsCount || 0) + 1;
      acc.lastUsed = new Date().toISOString();
      acc.status = 'active';
      fs.writeFileSync(file, JSON.stringify(acc, null, 2), 'utf8');
    } catch {}
  }
}

function recordAccountExpired(id, reason) {
  const dir = getAccountsDir();
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) {
    try {
      const acc = JSON.parse(fs.readFileSync(file, 'utf8'));
      acc.status = 'expired';
      acc.lastError = reason;
      fs.writeFileSync(file, JSON.stringify(acc, null, 2), 'utf8');
    } catch {}
  }
}

function getCookieStatus() {
  const file = getCookieFile();
  const accounts = getAccountsList();
  if (accounts.length > 0) {
    const active = accounts.filter(a => a.valid);
    return {
      hasCookies: true,
      valid: active.length > 0,
      expired: active.length === 0,
      cookieCount: accounts[0].cookieCount,
      accountsCount: accounts.length,
      message: `${active.length} active account(s)`
    };
  }

  if (!fs.existsSync(file)) {
    return { hasCookies: false, valid: false, expired: false, cookieCount: 0, message: 'No cookies found' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hasAuth = Array.isArray(raw) && raw.some(c => c.name === 'c_user' || c.name === 'xs');
    return {
      hasCookies: true,
      valid: hasAuth,
      expired: !hasAuth,
      cookieCount: raw.length,
      message: hasAuth ? 'Active session' : 'Missing c_user session cookie'
    };
  } catch (e) {
    return { hasCookies: false, valid: false, expired: true, cookieCount: 0, message: e.message };
  }
}

function saveCookies(cookiesData) {
  return saveAccount('Facebook Account 1', cookiesData);
}

function loadSavedCookies() {
  const file = getCookieFile();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function isConfigured() {
  const accounts = getAccountsList().filter(a => a.cookieCount > 0);
  const hasCookies = accounts.length > 0 || !!loadSavedCookies();
  return !!(hasCookies && isPuppeteerAvailable());
}

async function ensureLogin(page, customCookies = null, accountName = 'Facebook Account') {
  const raw = customCookies || loadSavedCookies();
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('No Facebook cookies found. Please paste cookies in Settings or Accounts tab.');
  }

  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies').catch(() => {});

    const cdpCookies = raw.map(c => ({
      name: c.name,
      value: String(c.value),
      domain: c.domain && c.domain.startsWith('.') ? c.domain : `.${c.domain || 'facebook.com'}`,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
    }));

    await client.send('Network.setCookies', { cookies: cdpCookies });
    console.log(`🍪 Applied ${cdpCookies.length} Facebook cookies for [${accountName}] via CDP`);

    const cookieHeader = raw.map(c => `${c.name}=${c.value}`).join('; ');
    await page.setExtraHTTPHeaders({
      'Cookie': cookieHeader,
    });

    return true;
  } catch (err) {
    console.warn('⚠️ Failed to apply Facebook cookies:', err.message);
    return false;
  }
}

async function dismissOverlays(page) {
  try {
    await page.evaluate(() => {
      // 1. Remove common cookie consent modals & dialogs
      const cookieButtons = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
      for (const b of cookieButtons) {
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        if (
          t === 'allow essential and optional cookies' ||
          t === 'allow all cookies' ||
          t === 'only allow essential cookies' ||
          t === 'decline optional cookies' ||
          t === 'accept all' ||
          t === 'close'
        ) {
          b.click();
          break;
        }
      }

      // 2. Remove backdrop layers if any
      document.querySelectorAll('[data-testid="cookie-policy-dialog"], [aria-label*="cookie" i]').forEach(el => el.remove());
    });
  } catch {}
}

async function postComment(postUrl, comment) {
  if (!isConfigured()) throw new Error('Facebook not configured. Please paste session cookies in Settings.');

  const browser = await getBrowser();
  const page = await newPageWithProxy(browser);

  const account = getNextAccount();
  const cookiesToUse = account ? account.cookies : loadSavedCookies();
  const accountName = account ? account.name : 'Facebook Account';

  console.log(`📘 [Facebook Rotation] Selected account: "${accountName}"`);

  try {
    await page.setViewport({ width: 1440, height: 900 }).catch(() => {});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    await ensureLogin(page, cookiesToUse, accountName);

    // Clean URL: strip tracking/app params
    let cleanUrl = postUrl.trim();
    if (cleanUrl.includes('facebook.com') && cleanUrl.includes('?')) {
      const [base, query] = cleanUrl.split('?');
      // Keep v=videoId for /watch/?v=123, otherwise drop params
      if (base.includes('/watch/')) {
        const vParam = new URLSearchParams(query).get('v');
        cleanUrl = vParam ? `${base}?v=${vParam}` : cleanUrl;
      } else {
        cleanUrl = base;
      }
    }

    console.log(`🌐 Loading Facebook post: ${cleanUrl}`);
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

    // Wait for hydration over proxy
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return text.length > 50 || document.querySelectorAll('div[role="textbox"], [contenteditable="true"]').length > 0;
    }, { timeout: 20000 }).catch(() => {});

    await delay(2000);
    await dismissOverlays(page);
    await delay(1000);

    // If it's a Reel or Watch page where comments are in a side drawer, try clicking Comment icon
    const isReelOrWatch = cleanUrl.includes('/reel/') || cleanUrl.includes('/watch');
    if (isReelOrWatch) {
      console.log('🎬 Reel/Watch detected — checking for comment drawer button...');
      await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('[role="button"], button, svg, div'));
        for (const el of allBtns) {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (aria === 'comment' || aria === 'comments' || aria.includes('leave a comment')) {
            el.click();
            break;
          }
        }
      });
      await delay(2000);
    }

    // ─── Find Comment Editor ───
    console.log('⏳ Looking for Facebook comment box...');
    let editorCoords = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      await dismissOverlays(page);

      editorCoords = await page.evaluate(() => {
        // 1. Direct editable textbox (Lexical or Draft.js)
        const textboxes = Array.from(document.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], div[data-lexical-editor="true"], div[aria-label*="comment" i], form textarea, div[contenteditable="true"]'
        ));

        for (const tb of textboxes) {
          const r = tb.getBoundingClientRect();
          if (r.width > 30 && r.height > 15 && r.bottom > 0) {
            tb.focus();
            tb.click();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }

        // 2. Placeholder box with text "Write a comment..."
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          const t = (el.innerText || el.textContent || el.getAttribute('placeholder') || '').trim().toLowerCase();
          if (t.includes('write a comment') || t.includes('write a public comment') || t.includes('comment as')) {
            const r = el.getBoundingClientRect();
            if (r.width > 30 && r.height > 15) {
              el.click();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
        }
        return null;
      });

      if (editorCoords) break;
      await delay(1500);
    }

    if (editorCoords) {
      console.log(`🎯 Found comment box at (${Math.round(editorCoords.x)}, ${Math.round(editorCoords.y)})`);
      await page.mouse.click(editorCoords.x, editorCoords.y);
      await delay(1000);
    } else {
      throw new Error('Facebook comment box not found. Make sure post is public and comments are enabled.');
    }

    // Type the comment naturally
    console.log(`💬 Typing Facebook comment: "${comment.substring(0, 50)}..."`);
    await page.keyboard.type(comment, { delay: 30 });
    await delay(1000);

    // Save proof of typed comment
    try {
      const editorProof = path.join(__dirname, '..', 'public', 'facebook_typed.png');
      await page.screenshot({ path: editorProof });
    } catch {}

    // Facebook comments submit on pressing Enter
    console.log('🚀 Submitting comment by pressing Enter...');
    await page.keyboard.press('Enter');
    await delay(1500);

    // Some layouts have an explicit send button (paper airplane icon or "Comment" button)
    await page.evaluate(() => {
      const sendBtn = Array.from(document.querySelectorAll('[role="button"], button')).find(b => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return aria === 'comment' || aria === 'post' || aria === 'send' || aria.includes('submit');
      });
      if (sendBtn) sendBtn.click();
    });

    await delay(5000);

    // Proof screenshot
    try {
      const proofPath = path.join(__dirname, '..', 'public', 'facebook_last_post.png');
      await page.screenshot({ path: proofPath });
      console.log('📸 Saved proof screenshot to public/facebook_last_post.png');
    } catch {}

    if (account && account.id) {
      recordAccountPostSuccess(account.id);
    }

    return {
      success: true,
      url: postUrl,
      comment,
      account: accountName,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    if (account && account.id && /session expired|login|checkpoint/i.test(err.message)) {
      recordAccountExpired(account.id, err.message);
    }
    try {
      const errPath = path.join(__dirname, '..', 'public', 'facebook_last_error.png');
      await page.screenshot({ path: errPath });
      console.warn('📸 Saved debug screenshot to public/facebook_last_error.png');
    } catch {}
    throw err;
  } finally {
    await page.close();
  }
}

async function testConnection() {
  if (!isPuppeteerAvailable()) return { ok: false, message: 'Puppeteer not installed' };
  const status = getCookieStatus();
  if (status.hasCookies && status.valid) {
    return { ok: true, message: `Connected via session cookies (${status.cookieCount} cookies, ${status.accountsCount || 1} account)` };
  }
  return { ok: false, message: 'No valid Facebook session cookies. Please paste cookies in Settings or Accounts.' };
}

const COUNTRY_TOPICS = {
  IN: ['Bollywood', 'Cricket', 'Desi Memes', 'Indian Viral Video', 'Daily News India'],
  ID: ['Viral Indonesia', 'Berita Viral', 'Video Lucu', 'Trending Indonesia'],
  US: ['Viral News', 'Top Videos', 'Trending Reels', 'Daily Humor'],
  GB: ['UK News', 'Trending UK', 'Viral Reels'],
  DEFAULT: ['Trending Viral', 'Top Video', 'World News'],
};

async function getTrending(regionCode = 'US', maxResults = 20) {
  const code = (regionCode || 'US').toUpperCase();
  const topics = COUNTRY_TOPICS[code] || COUNTRY_TOPICS.DEFAULT;
  return topics.slice(0, maxResults).map((topic, i) => ({
    id: `fb_${code}_${i}`,
    title: `${topic} — Popular on Facebook`,
    url: `https://www.facebook.com/watch/search/?q=${encodeURIComponent(topic)}`,
    thumbnail: 'https://static.xx.fbcdn.net/rsrc.php/v3/y2/r/13w1lD_j0sM.png',
    channel: `Facebook Watch • ${code}`,
    views: '🔥 Popular Content',
  }));
}

module.exports = {
  ...META,
  isConfigured,
  testConnection,
  postComment,
  getTrending,
  getCookieStatus,
  saveCookies,
  getAccountsList,
  saveAccount,
  deleteAccount,
  getNextAccount,
};
