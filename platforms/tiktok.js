// ============================================================
// platforms/tiktok.js — TikTok via Puppeteer automation
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getBrowser, newPageWithProxy, isPuppeteerAvailable } = require('./browser');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to read latest environment variables dynamically
const getTikTokCredentials = () => ({
  username: process.env.TIKTOK_USERNAME || '',
  password: process.env.TIKTOK_PASSWORD || '',
});

let sessionCookies = null; // cache login session
let lastCookieError = null; // tracks runtime session invalidation

function getCookieFile() {
  return path.join(__dirname, '..', 'tokens', 'tiktok_cookies.json');
}

function getCookieStatus() {
  const file = getCookieFile();
  if (!fs.existsSync(file)) {
    return { hasCookies: false, valid: false, expired: false, cookieCount: 0, message: 'No cookies file found' };
  }
  try {
    const stat = fs.statSync(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) {
      return { hasCookies: false, valid: false, expired: true, cookieCount: 0, message: 'Cookies file is empty' };
    }

    const sessionCookie = raw.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_guard');
    let expiresAt = null;
    let isExpired = false;

    if (sessionCookie && sessionCookie.expirationDate) {
      const expMs = sessionCookie.expirationDate * 1000;
      expiresAt = new Date(expMs).toISOString();
      if (Date.now() > expMs) {
        isExpired = true;
      }
    }

    // Check age in hours (file mtime)
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    // TikTok web sessions typically invalidate after 36-48h
    if (ageHours > 48) {
      isExpired = true;
    }

    // If runtime verification caught a login/signup popup, mark as expired
    if (lastCookieError) {
      isExpired = true;
    }

    return {
      hasCookies: true,
      valid: !isExpired,
      expired: isExpired,
      cookieCount: raw.length,
      hasSessionId: !!sessionCookie,
      expiresAt: expiresAt,
      updatedAt: stat.mtime.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      reason: lastCookieError || (isExpired ? 'Session age exceeded 48 hours' : 'Active'),
    };
  } catch (err) {
    return { hasCookies: true, valid: false, expired: true, cookieCount: 0, message: err.message };
  }
}

function saveCookies(cookiesData) {
  let parsed;
  if (typeof cookiesData === 'string') {
    parsed = JSON.parse(cookiesData.trim());
  } else {
    parsed = cookiesData;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Invalid cookies format — must be a JSON array of cookie objects from Cookie-Editor');
  }

  const dir = path.dirname(getCookieFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(getCookieFile(), JSON.stringify(parsed, null, 2), 'utf8');
  sessionCookies = null; // clear in-memory cache
  lastCookieError = null; // reset any previous expired flag
  return getCookieStatus();
}

function loadSavedCookies() {
  const file = getCookieFile();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const cookies = [];
    for (const c of raw) {
      if (!c.name || c.value === undefined) continue;
      // TikTok cookies MUST be set at domain level (.tiktok.com) WITHOUT 'url' parameter
      // so Chrome sends them to www.tiktok.com, m.tiktok.com, and all subdomains.
      const domain = c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : '.tiktok.com';
      const item = {
        name: c.name,
        value: String(c.value),
        domain: domain,
        path: c.path || '/',
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
      };
      if (c.sameSite === 'no_restriction') item.sameSite = 'None';
      else if (c.sameSite === 'lax') item.sameSite = 'Lax';
      else if (c.sameSite === 'strict') item.sameSite = 'Strict';
      cookies.push(item);

      // If cookie was exported with domain .www.tiktok.com, also add .tiktok.com copy
      if (domain === '.www.tiktok.com') {
        cookies.push({ ...item, domain: '.tiktok.com' });
      }
    }
    return cookies;
  } catch (err) {
    console.warn('⚠️ Error loading saved TikTok cookies:', err.message);
    return null;
  }
}

// ─── Multi-Account Support & Rotation ───────────────────────
function getAccountsDir() {
  const dir = path.join(__dirname, '..', 'tokens', 'tiktok_accounts');
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
          const accData = {
            id: accId,
            name: 'Account 1 (@renepacho1)',
            username: '@renepacho1',
            cookies: raw,
            postsCount: 1,
            addedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            status: 'active'
          };
          fs.writeFileSync(path.join(dir, `${accId}.json`), JSON.stringify(accData, null, 2), 'utf8');
          console.log('✅ Migrated existing TikTok cookies to Account 1');
        }
      } catch (e) {
        console.warn('⚠️ Could not migrate legacy TikTok cookies:', e.message);
      }
    }
  }
}

// Auto-initialize on module load
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
      const sessionCookie = cookies.find(c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_guard');
      let isExpired = acc.status === 'expired';
      if (sessionCookie && sessionCookie.expirationDate) {
        const expMs = sessionCookie.expirationDate * 1000;
        if (Date.now() > expMs) isExpired = true;
      }
      list.push({
        id: acc.id || f.replace('.json', ''),
        name: acc.name || acc.username || f.replace('.json', ''),
        username: acc.username || '',
        cookieCount: cookies.length,
        postsCount: acc.postsCount || 0,
        addedAt: acc.addedAt || stat.birthtime.toISOString(),
        lastUsed: acc.lastUsed || stat.mtime.toISOString(),
        valid: !isExpired && cookies.length > 0,
        expired: isExpired,
        status: isExpired ? 'expired' : 'active',
        reason: acc.lastError || (isExpired ? 'Session expired' : 'Active'),
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
  const existingCount = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  const cleanName = (name || '').trim() || `Account ${existingCount + 1}`;

  const accData = {
    id,
    name: cleanName,
    username: cleanName.startsWith('@') ? cleanName : '',
    cookies: parsed,
    postsCount: 0,
    addedAt: new Date().toISOString(),
    lastUsed: null,
    status: 'active'
  };

  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(accData, null, 2), 'utf8');

  // Also sync to legacy single file for compatibility
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
  if (id === 'legacy' || id === 'tiktok_cookies' || id === 'default') {
    const legacyFile = getCookieFile();
    if (fs.existsSync(legacyFile)) {
      fs.unlinkSync(legacyFile);
      return true;
    }
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


const META = {
  id:     'tiktok',
  name:   'TikTok',
  icon:   '🎵',
  color:  '#010101',
  accent: '#fe2c55',
  supportsTrending: true,
  credentialFields: [
    { key: 'TIKTOK_USERNAME', label: 'Username / Email', type: 'text',     placeholder: 'your@email.com' },
    { key: 'TIKTOK_PASSWORD', label: 'Password',         type: 'password', placeholder: '••••••••' },
  ],
};

function isConfigured() {
  const { username, password } = getTikTokCredentials();
  const accounts = getAccountsList().filter(a => a.cookieCount > 0);
  const hasCookies = accounts.length > 0 || !!loadSavedCookies();
  return !!((hasCookies || (username && password)) && isPuppeteerAvailable());
}

async function ensureLogin(page, customCookies = null, accountName = "TikTok Account") {
  // 1. Check for custom cookies or saved session cookies (Bypasses captchas!)
  const raw = customCookies || loadSavedCookies();
  if (Array.isArray(raw) && raw.length > 0) {
    try {
      // Clear previous cookies & set directly via CDP
      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies').catch(() => {});
        const cdpCookies = raw.map(c => ({
          name: c.name,
          value: String(c.value),
          domain: c.domain && c.domain.startsWith('.') ? c.domain : `.${c.domain || 'tiktok.com'}`,
          path: c.path || '/',
          secure: true,
          httpOnly: Boolean(c.httpOnly),
        }));
        await client.send('Network.setCookies', { cookies: cdpCookies });
        console.log(`🍪 Applied ${cdpCookies.length} TikTok cookies for [${accountName}] via CDP Network.setCookies`);
      } catch (cdpErr) {
        console.warn('⚠️ CDP cookie set warning:', cdpErr.message);
      }

      // Explicit Cookie HTTP header
      const cookieHeader = raw.map(c => `${c.name}=${c.value}`).join('; ');
      await page.setExtraHTTPHeaders({
        'Cookie': cookieHeader,
      });

      return true;
    } catch (cookieErr) {
      console.warn('⚠️ Failed to apply cookies:', cookieErr.message);
    }
  }

  // 2. Full login flow fallback
  await page.goto('https://www.tiktok.com/login/phone-or-email/email', {
    waitUntil: 'domcontentloaded', timeout: 35000,
  });
  await delay(3000);

  // Switch to "Log in with email or username" if needed
  try {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, div, span'));
      for (const el of els) {
        if (/log in with email|email or username/i.test(el.innerText || '')) {
          el.click();
          break;
        }
      }
    });
    await delay(1500);
  } catch {}

  // Switch to "Log in with password" if showing code login
  try {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, div, span'));
      for (const el of els) {
        if (/log in with password|with password/i.test(el.innerText || '')) {
          el.click();
          break;
        }
      }
    });
    await delay(1500);
  } catch {}

  const { username, password } = getTikTokCredentials();

  // Fill username/email
  const usernameSelectors = [
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
  ];
  for (const sel of usernameSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await delay(200);
        await el.type(username, { delay: 60 });
        break;
      }
    } catch {}
  }

  await delay(800);

  // Toggle "Log in with password" again if needed
  try {
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, div, span'));
      for (const el of els) {
        if (/log in with password|with password/i.test(el.innerText || '')) {
          el.click();
          break;
        }
      }
    });
    await delay(1500);
  } catch {}

  // Find password field
  const passwordSelectors = [
    'input[type="password"]',
    'input[autocomplete*="password"]',
    'input[placeholder*="password" i]',
  ];

  let passField = null;
  for (const sel of passwordSelectors) {
    passField = await page.waitForSelector(sel, { timeout: 4000 }).catch(() => null);
    if (passField) {
      await passField.click();
      await delay(200);
      await passField.type(password, { delay: 60 });
      break;
    }
  }

  if (!passField) {
    throw new Error('TikTok login: password input not found. TikTok may require manual captcha verification or email code.');
  }

  await delay(800);

  // Click login button
  const loginBtnSelectors = ['button[data-e2e="login-button"]', 'button[type="submit"]', 'button.login-button', 'form button'];
  for (const sel of loginBtnSelectors) {
    const el = await page.$(sel);
    if (el) { await el.click(); break; }
  }

  await delay(6000);
  sessionCookies = await page.cookies();
  return !page.url().includes('/login');
}

async function postComment(videoUrl, comment) {
  if (!isConfigured()) throw new Error('TikTok credentials not configured (TIKTOK_USERNAME / TIKTOK_PASSWORD)');

  const browser = await getBrowser();
  const page    = await newPageWithProxy(browser);

  try {
    await page.setViewport({ width: 1440, height: 900 }).catch(() => {});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    const account = getNextAccount();
    const cookiesToUse = account ? account.cookies : loadSavedCookies();
    const accountName = account ? account.name : 'TikTok Account';
    console.log(`🎵 [TikTok Rotation] Selected account: "${accountName}"`);

    const loggedIn = await ensureLogin(page, cookiesToUse, accountName);
    if (!loggedIn) throw new Error('TikTok login failed — check credentials or cookies');

    // Clean URL: strip tracking/mobile query params (e.g. ?q=... from share links)
    const cleanVideoUrl = videoUrl.split('?')[0];
    console.log(`🌐 Loading video: ${cleanVideoUrl} (original: ${videoUrl})`);
    await page.goto(cleanVideoUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

    // Wait up to 20s for TikTok page to hydrate over residential proxies
    console.log('⏳ Waiting for video page hydration...');
    await page.waitForFunction(() => {
      const text = document.body ? document.body.innerText : '';
      return text.includes('Comments') || document.querySelectorAll('button').length > 10;
    }, { timeout: 20000 }).catch(() => {});
    await delay(1500);

    // Dismiss & remove any cookie/guest banner from DOM so it cannot block clicks
    try {
      await page.evaluate(() => {
        // Try clicking Allow All button first
        const btns = Array.from(document.querySelectorAll('button, a, div'));
        const allowBtn = btns.find(b => /allow all|accept|continue as guest/i.test((b.innerText || b.textContent || '').trim()));
        if (allowBtn) allowBtn.click();

        // Also remove host element and overlay
        document.querySelectorAll('tiktok-cookie-banner, [class*="cookie-banner"], [id*="cookie-banner"]').forEach(el => el.remove());
      });
      await delay(800);
    } catch {}

    // ─── Step 1: Wait for & Click Comments Tab ─────────────────
    console.log('⏳ Finding and clicking Comments tab...');
    let commentsTabCoords = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      // Dismiss any overlay or modal
      await page.keyboard.press('Escape').catch(() => {});

      // Remove cookie banner again if re-injected
      await page.evaluate(() => {
        document.querySelectorAll('tiktok-cookie-banner, [class*="cookie-banner"], [id*="cookie-banner"]').forEach(el => el.remove());
      }).catch(() => {});

      commentsTabCoords = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        // 1. Look for tab with exact text "Comments" at top right
        for (const el of all) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t === 'Comments' || /^comments?(\s*\(.*\))?$/i.test(t)) {
            const r = el.getBoundingClientRect();
            if (r.left > 650 && r.top < 250 && r.width > 20 && r.height > 10) {
              el.click();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t, tag: el.tagName };
            }
          }
        }
        // 2. Fallback: look for comment action icon next to video
        const actionIcons = Array.from(document.querySelectorAll('[data-e2e*="comment"], [aria-label*="comment" i]'));
        for (const el of actionIcons) {
          const r = el.getBoundingClientRect();
          if (r.width > 15 && r.height > 15 && r.left > 500) {
            el.click();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: 'action-icon', tag: el.tagName };
          }
        }
        return null;
      });

      if (commentsTabCoords) break;
      await delay(1500);
    }

    if (commentsTabCoords) {
      console.log(`🎯 Found & clicking Comments tab [${commentsTabCoords.tag}] at (${Math.round(commentsTabCoords.x)}, ${Math.round(commentsTabCoords.y)})`);
      await page.mouse.click(commentsTabCoords.x, commentsTabCoords.y);
      await delay(2000);
    } else {
      console.warn('⚠️ Comments tab not found by text after waiting — checking if comments are already open...');
    }

    // Check if video is unavailable or comments are turned off
    const videoStatus = await page.evaluate(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (/comments are turned off|comments have been disabled/i.test(text)) return 'Comments are turned off for this video';
      if (/video currently unavailable|video is private/i.test(text)) return 'Video is unavailable or private';
      return null;
    });
    if (videoStatus) {
      throw new Error(`TikTok: ${videoStatus}`);
    }

    // ─── Step 2: Wait for & Click "Add comment..." Input Bar ───
    console.log('⏳ Waiting for "Add comment..." input bar...');
    let placeholderCoords = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      // Remove banner again to ensure clicks hit the placeholder
      await page.evaluate(() => {
        document.querySelectorAll('tiktok-cookie-banner, [class*="cookie-banner"]').forEach(el => el.remove());
      }).catch(() => {});

      placeholderCoords = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          const t = (el.innerText || el.textContent || el.getAttribute('placeholder') || '').trim().toLowerCase();
          if (t === 'add comment...' || t === 'add comment' || t.startsWith('add comment')) {
            const r = el.getBoundingClientRect();
            if (r.width > 20 && r.height > 10 && r.left > 500) {
              el.click();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t };
            }
          }
        }
        return null;
      });

      if (placeholderCoords) break;
      await delay(1500);
    }

    if (placeholderCoords) {
      console.log(`🎯 Clicked "Add comment..." placeholder at (${Math.round(placeholderCoords.x)}, ${Math.round(placeholderCoords.y)})`);
      await page.mouse.click(placeholderCoords.x, placeholderCoords.y);
      await delay(1500);
    } else {
      console.warn('⚠️ "Add comment..." placeholder not found by text after waiting, clicking default bottom area (1150, 865)...');
      await page.mouse.click(1150, 865);
      await delay(1500);
    }

    // ─── Step 3: Wait for [contenteditable="true"] DraftEditor ──
    let commentInput = await page.waitForSelector('[contenteditable="true"], div.DraftEditor-root [contenteditable="true"]', { timeout: 10000 }).catch(() => null);

    if (!commentInput) {
      const loginPrompt = await page.evaluate(() => {
        const text = document.body ? document.body.innerText || '' : '';
        if (/when's your birthday\?/i.test(text)) return 'TikTok signup prompt ("When\'s your birthday?") detected — session expired';
        if (/log in to comment/i.test(text)) return 'TikTok "Log in to comment" detected — session expired';
        if (/log in to tiktok/i.test(text)) return 'TikTok "Log in to TikTok" modal detected — session expired';
        return null;
      });
      if (loginPrompt) {
        lastCookieError = loginPrompt;
        throw new Error(`${loginPrompt}. Please update cookies in dashboard Settings.`);
      }
      throw new Error('Comment input editor did not open after clicking "Add comment..."');
    }

    await commentInput.click();
    await delay(500);

    // 1. Try native Puppeteer typing directly into the active Draft.js editor
    console.log(`💬 Typing comment: "${comment}"`);
    await page.keyboard.type(comment, { delay: 25 });
    await delay(800);

    // Verify if text was entered
    let editorText = await page.evaluate(() => {
      const el = document.querySelector('[contenteditable="true"]');
      return el ? (el.innerText || el.textContent || '').trim() : '';
    });

    // 2. If keyboard typing didn't populate Draft.js, fallback to execCommand + input events
    if (!editorText || editorText.length === 0) {
      console.log('⚠️ Editor text empty after keyboard.type, trying execCommand injection...');
      await page.evaluate((text) => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, comment);
      await delay(1000);

      editorText = await page.evaluate(() => {
        const el = document.querySelector('[contenteditable="true"]');
        return el ? (el.innerText || el.textContent || '').trim() : '';
      });
    }

    console.log(`📝 Verified text in editor (${editorText.length} chars): "${editorText.substring(0, 40)}..."`);
    if (!editorText || editorText.length === 0) {
      throw new Error('TikTok: Failed to type comment into the Draft.js editor box');
    }

    // Save proof of filled editor before submitting
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'public', 'tiktok_editor_filled.png') });
    } catch {}

    // Find and click Post button
    const postClicked = await page.evaluate(() => {
      // 1. data-e2e="comment-post"
      const e2eBtn = document.querySelector('[data-e2e="comment-post"]');
      if (e2eBtn) {
        const r = e2eBtn.getBoundingClientRect();
        e2eBtn.click();
        return { clicked: true, x: r.left + r.width / 2, y: r.top + r.height / 2, type: 'data-e2e' };
      }
      // 2. Element with text "Post" in bottom right
      const all = Array.from(document.querySelectorAll('button, div, span'));
      for (const el of all) {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (t === 'post') {
          const r = el.getBoundingClientRect();
          if (r.left > 800 && r.top > 600 && r.width > 15 && r.height > 10) {
            el.click();
            return { clicked: true, x: r.left + r.width / 2, y: r.top + r.height / 2, type: 'text-post' };
          }
        }
      }
      return null;
    });

    if (postClicked) {
      console.log(`🚀 Clicked Post button at (${Math.round(postClicked.x)}, ${Math.round(postClicked.y)}) [${postClicked.type}]`);
      await page.mouse.click(postClicked.x, postClicked.y);
    } else {
      console.log('⌨️ Post button not found, pressing Enter key...');
      await page.keyboard.press('Enter');
    }

    // Also send Enter key as confirmation
    await delay(1000);
    await page.keyboard.press('Enter').catch(() => {});

    // Wait for comment to submit and render
    await delay(6000);

    // Always take a proof screenshot of the post attempt
    try {
      const proofPath = path.join(__dirname, '..', 'public', 'tiktok_last_post.png');
      await page.screenshot({ path: proofPath });
      console.log(`📸 Saved post screenshot to public/tiktok_last_post.png`);
    } catch {}

    const postStatus = await page.evaluate((originalComment) => {
      // 1. Check if comment was posted (appears in list or editor was cleared)
      const comments = Array.from(document.querySelectorAll('[data-e2e="comment-level-1"], [class*="CommentItem"], [class*="comment-text"], div[class*="comment"]'));
      const foundInList = comments.some(c => {
        const t = c.innerText || '';
        return t.includes(originalComment.slice(0, 15)) || ((t.includes('1s ago') || t.includes('Just now')) && t.includes('renepacho1'));
      });

      const editor = document.querySelector('[contenteditable="true"].public-DraftEditor-content, [contenteditable="true"]');
      const remainingText = editor ? (editor.innerText || '').trim() : '';

      // If the comment appears in comments list OR editor text is gone, it successfully posted!
      if (foundInList || remainingText.length === 0) {
        return { success: true, remainingText: '', foundInList: true };
      }

      // 2. Check for VISIBLE TikTok captcha / puzzle challenge modal
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 50 && rect.height > 50;
      };

      const captchaEl = Array.from(document.querySelectorAll('div[class*="captcha" i], div[class*="secsdk" i], [id*="captcha" i], [class*="verify" i]')).find(el => {
        const text = (el.innerText || el.textContent || '').toLowerCase();
        return isVisible(el) && (text.includes('drag the slider') || text.includes('fit the puzzle') || text.includes('security check'));
      });
      if (captchaEl) {
        return { error: 'Security puzzle captcha triggered ("Drag the slider to fit the puzzle").' };
      }

      // 3. Check for TikTok toast / error notifications
      const toasts = Array.from(document.querySelectorAll('[role="alert"], div[class*="toast"], div[class*="Toast"], [class*="modal"]'));
      for (const t of toasts) {
        if (isVisible(t)) {
          const text = (t.innerText || t.textContent || '').trim();
          if (text && /too fast|failed|error|blocked|prohibited|guidelines/i.test(text)) {
            return { error: text };
          }
        }
      }

      return { remainingText, foundInList };
    }, comment);

    if (postStatus.error) {
      throw new Error(`TikTok rejected comment: ${postStatus.error}`);
    }

    // If editor still holds the comment text after clicking submit, it didn't send
    if (postStatus.remainingText && postStatus.remainingText.length > 3) {
      throw new Error(`TikTok comment submission failed: text remained in editor (${postStatus.remainingText.substring(0, 30)}...)`);
    }

    return { success: true, platform: 'tiktok' };
  } catch (err) {
    try {
      const errPath = path.join(__dirname, '..', 'public', 'tiktok_last_error.png');
      await page.screenshot({ path: errPath });
      console.warn(`📸 Saved debug screenshot to public/tiktok_last_error.png (URL: ${page.url()})`);
    } catch {}
    throw err;
  } finally {
    await page.close();
  }
}

async function getTrending(regionCode = 'US', maxResults = 20) {
  if (!isPuppeteerAvailable()) throw new Error('Puppeteer not installed');

  const browser = await getBrowser();
  const page    = await newPageWithProxy(browser);

  try {
    await page.setViewport({ width: 1440, height: 900 }).catch(() => {});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // Authenticate with saved cookies so TikTok doesn't gatekeep or show guest popups
    await ensureLogin(page).catch(() => {});

    // Regional targeting:
    // On TikTok web, /search/video?q=... is the official and most reliable desktop discovery feed.
    let targetUrl;
    if (regionCode && regionCode.toUpperCase().startsWith('IN')) {
      const indianTags = ['hindi', 'desi', 'bollywood', 'indian'];
      const chosenTag = indianTags[Math.floor(Math.random() * indianTags.length)];
      targetUrl = `https://www.tiktok.com/tag/${chosenTag}`;
      console.log(`🇮🇳 Targeting Indian TikTokers via tag page: "${chosenTag}"`);
    } else {
      targetUrl = 'https://www.tiktok.com/tag/viral';
    }

    console.log(`🌐 Navigating to discovery page: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await delay(4000);

    // Dismiss any modal or banner
    await page.keyboard.press('Escape').catch(() => {});
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, div, span, a'));
        for (const b of btns) {
          const t = (b.innerText || '').trim().toLowerCase();
          if (t === 'allow all' || t === 'accept' || t === 'continue as guest' || t === 'skip' || t === 'close') {
            b.click();
          }
        }
      });
    } catch {}

    // Wait up to 15s for video cards to render in the DOM
    console.log('⏳ Waiting for video results to appear...');
    await page.waitForSelector('a[href*="/video/"]', { timeout: 15000 }).catch(() => null);

    // Scroll 3 times to trigger lazy-loading of thumbnails and items
    for (let s = 0; s < 3; s++) {
      try {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await delay(1200);
      } catch {}
    }

    // Save debug screenshot of discovery page
    try {
      await page.screenshot({ path: path.join(__dirname, '..', 'public', 'tiktok_trending_debug.png') });
    } catch {}

    const videos = await page.evaluate((max) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        if (results.length >= max) break;
        const href = a.href || '';
        if (!href.includes('/video/') || seen.has(href)) continue;
        seen.add(href);

        const img = a.querySelector('img');
        const titleEl = a.querySelector('[class*="title"], [class*="desc"], p, span[class*="text"], [data-e2e*="desc"]');
        const username = href.split('@')[1]?.split('/')[0] || 'tiktoker';

        results.push({
          id:        href.split('/video/')[1]?.split('?')[0] || '',
          title:     titleEl?.innerText?.trim().substring(0, 120) || `Video by @${username}`,
          url:       href,
          thumbnail: img?.src || '',
          channel:   `@${username}`,
          views:     '',
        });
      }
      return results;
    }, maxResults);

    console.log(`✅ Discovered ${videos.length} videos from ${targetUrl} (Current URL: ${page.url()})`);
    return videos.filter(v => v.id);
  } finally {
    await page.close();
  }
}

async function testConnection() {
  if (!isPuppeteerAvailable()) return { ok: false, message: 'Puppeteer not installed' };
  const status = getCookieStatus();
  if (status.hasCookies) {
    if (status.expired) {
      return { ok: false, message: `Session cookies expired (${status.reason || `updated ${status.ageHours}h ago`}). Please paste fresh cookies in Settings.` };
    }
    return { ok: true, message: `Connected via session cookies (${status.cookieCount} cookies, updated ${status.ageHours}h ago)` };
  }
  const { username, password } = getTikTokCredentials();
  if (!username || !password) return { ok: false, message: 'No session cookies and TIKTOK_USERNAME / TIKTOK_PASSWORD not set' };
  return { ok: true, message: `Configured as @${username} — will log in on first post` };
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
