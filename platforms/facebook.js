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
  if (id === 'legacy' || id === 'facebook_cookies' || id === 'default') {
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
      if (cleanUrl.includes('/search')) {
        cleanUrl = postUrl.trim();
      } else if (base.includes('/watch/')) {
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

    // If it's a search page (e.g. from Trending topics), navigate into top video in results
    if (cleanUrl.includes('/search')) {
      console.log('🔍 Facebook search page detected — finding top video in results...');
      const topVideoUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/watch/?v="], a[href*="/reel/"], a[href*="/videos/"]'));
        for (const l of links) {
          if (l.href && !l.href.includes('/search')) return l.href;
        }
        return null;
      });

      if (topVideoUrl) {
        console.log(`🎬 Navigating into top video: ${topVideoUrl}`);
        cleanUrl = topVideoUrl.split('&')[0];
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForFunction(() => {
          const text = document.body ? document.body.innerText : '';
          return text.length > 50 || document.querySelectorAll('div[role="textbox"], [contenteditable="true"]').length > 0;
        }, { timeout: 20000 }).catch(() => {});
        await delay(2000);
        await dismissOverlays(page);
      }
    }

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

const FALLBACK_TRENDING = {
  IN: [
    { title: 'Bollywood Viral Dance & Music Trends', query: 'bollywood dance viral reels', thumb: 'https://images.unsplash.com/photo-1547153760-18fc86324498?w=600&auto=format&fit=crop&q=80', channel: 'Bollywood Hungama' },
    { title: 'Indian Cricket & IPL Top Match Moments', query: 'cricket highlights viral video', thumb: 'https://images.unsplash.com/photo-1531415074868-836332ff4296?w=600&auto=format&fit=crop&q=80', channel: 'CricTracker' },
    { title: 'Desi Memes & Stand-Up Comedy Viral Clips', query: 'desi comedy memes viral', thumb: 'https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=600&auto=format&fit=crop&q=80', channel: 'Desi Humor' },
    { title: 'Indian Street Food & Culinary Viral Shorts', query: 'indian street food viral reels', thumb: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&auto=format&fit=crop&q=80', channel: 'Foodie Express India' },
    { title: 'Top Hindi Movie Scenes & Dialogues', query: 'hindi movie scene viral', thumb: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=600&auto=format&fit=crop&q=80', channel: 'Filmi Buzz' },
    { title: 'Punjabi Beats & Bhangra Viral Trends', query: 'punjabi song viral reel', thumb: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80', channel: 'Desi Tunes' },
    { title: 'Daily Breaking News India Viral Coverage', query: 'daily news india viral video', thumb: 'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=600&auto=format&fit=crop&q=80', channel: 'India Today News' },
    { title: 'Desi Jugaad & Innovation Viral Videos', query: 'desi jugaad viral video', thumb: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=600&auto=format&fit=crop&q=80', channel: 'Tech Jugaad India' },
    { title: 'Indian Wedding Dance & Celebration Viral Clips', query: 'indian wedding dance reel', thumb: 'https://images.unsplash.com/photo-1583939003579-730e3918a45a?w=600&auto=format&fit=crop&q=80', channel: 'Wedding Bells India' },
    { title: 'Motivational Hindi Speeches & Life Lessons', query: 'hindi motivation viral video', thumb: 'https://images.unsplash.com/photo-1475721027785-f74eccf877e2?w=600&auto=format&fit=crop&q=80', channel: 'Inspire India' },
    { title: 'Indian Bike Stunts & Auto Viral Clips', query: 'india viral bike stunt reels', thumb: 'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=600&auto=format&fit=crop&q=80', channel: 'Speed India' },
    { title: 'South Indian Blockbusters Hindi Dubbed Scenes', query: 'south movie hindi dubbed viral', thumb: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=600&auto=format&fit=crop&q=80', channel: 'South Cinema Hindi' },
    { title: 'Viral College Campus & Student Funny Moments', query: 'college funny moments india reel', thumb: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=600&auto=format&fit=crop&q=80', channel: 'Campus Masti' },
    { title: 'Indian Village Life & Rural Culture Stories', query: 'village life india viral video', thumb: 'https://images.unsplash.com/photo-1509099836639-18ba1795216d?w=600&auto=format&fit=crop&q=80', channel: 'Desi Gaon' },
    { title: 'Top Spiritual & Bhakti Viral Bhajans', query: 'bhajan bhakti viral video', thumb: 'https://images.unsplash.com/photo-1545063914-a1a6ec821c88?w=600&auto=format&fit=crop&q=80', channel: 'Bhakti Sagar' },
    { title: 'Indian Talent Show & Reality TV Viral Highlights', query: 'indian talent show viral clip', thumb: 'https://images.unsplash.com/photo-1469488865564-c2de10f69f96?w=600&auto=format&fit=crop&q=80', channel: 'Talent Hunt India' },
    { title: 'Hindi Rap & Hip-Hop Underground Trends', query: 'desi hip hop viral reel', thumb: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=600&auto=format&fit=crop&q=80', channel: 'Gully Beats' },
    { title: 'Fitness, Yoga & Gym Motivation India', query: 'desi fitness gym viral reels', thumb: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=600&auto=format&fit=crop&q=80', channel: 'Fit India' },
    { title: 'Family Drama & Daily Soap Opera Viral Clips', query: 'daily soap viral drama clip', thumb: 'https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?w=600&auto=format&fit=crop&q=80', channel: 'Desi Drama' },
    { title: 'Cute Indian Kids & Babies Viral Reels', query: 'cute baby funny video india', thumb: 'https://images.unsplash.com/photo-1516627145497-ae6968895b74?w=600&auto=format&fit=crop&q=80', channel: 'Baby Masti' },
  ],
  DEFAULT: [
    { title: 'Top Viral Reels Today', query: 'viral reels trending', thumb: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop&q=80', channel: 'Facebook Viral' },
    { title: 'Trending Comedy & Humor Clips', query: 'funny comedy video', thumb: 'https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=600&auto=format&fit=crop&q=80', channel: 'Comedy Central' },
    { title: 'World Breaking News & Top Stories', query: 'breaking news today', thumb: 'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?w=600&auto=format&fit=crop&q=80', channel: 'Global News' },
    { title: 'Viral Music Videos & Hits', query: 'music video viral', thumb: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80', channel: 'Music Trends' },
  ]
};

async function getTrending(regionCode = 'US', maxResults = 20) {
  const code = (regionCode || 'US').toUpperCase();
  const max = Math.min(Number(maxResults) || 20, 50);

  // 1. Try Live Puppeteer Scraping if available
  if (isPuppeteerAvailable()) {
    let browser = null;
    let page = null;
    try {
      browser = await getBrowser();
      page = await newPageWithProxy(browser);
      await page.setViewport({ width: 1440, height: 900 }).catch(() => {});
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

      await ensureLogin(page).catch(() => {});

      let targetUrl = code === 'IN'
        ? 'https://www.facebook.com/watch'
        : 'https://www.facebook.com/watch';

      console.log(`🌐 Scraping Facebook trending videos from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await delay(3000);
      await dismissOverlays(page);

      // Scroll 5 times to trigger lazy loading of distinct video cards
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await delay(1200);
      }

      const scraped = await page.evaluate((limit) => {
        const results = [];
        const seenIds = new Set();
        const seenTitles = new Set();

        function getFbId(url) {
          if (!url) return null;
          const v = url.match(/[?&]v=(\d+)/);
          if (v) return v[1];
          const r = url.match(/\/(?:reel|videos)\/(\d+)/);
          if (r) return r[1];
          const m = url.match(/\/(\d{8,20})/);
          if (m) return m[1];
          return null;
        }

        // Find all links to videos or reels
        const links = Array.from(document.querySelectorAll('a[href*="/watch"], a[href*="/reel/"], a[href*="/videos/"]'));

        for (const a of links) {
          if (results.length >= limit) break;
          const rawHref = a.href || '';
          if (!rawHref) continue;

          const vidId = getFbId(rawHref);
          if (vidId && seenIds.has(vidId)) continue;

          // Find card container
          const card = a.closest('div[role="article"]') || a.closest('div[role="feed"] > div') || a.parentElement;
          
          // Title / Caption
          const textEl = card ? card.querySelector('div[dir="auto"], h2, [class*="text"], span') : a;
          const title = (textEl ? textEl.innerText : a.innerText || '').trim().replace(/\s+/g, ' ');
          if (title && seenTitles.has(title.toLowerCase())) continue;

          // Thumbnail image
          const img = card ? card.querySelector('img[src*="fbcdn"], img[src*="scontent"], img') : a.querySelector('img');
          const thumb = img ? img.src : '';

          // Creator / Channel
          const authorEl = card ? card.querySelector('strong, h3, a[role="link"] span') : null;
          const channel = (authorEl ? authorEl.innerText : 'Facebook Creator').trim();

          // Standardized URL
          let cleanHref = rawHref;
          if (vidId) {
            cleanHref = rawHref.includes('/reel/') 
              ? `https://www.facebook.com/reel/${vidId}`
              : `https://www.facebook.com/watch/?v=${vidId}`;
            seenIds.add(vidId);
          } else {
            cleanHref = rawHref.split('?')[0];
            if (seenIds.has(cleanHref)) continue;
            seenIds.add(cleanHref);
          }

          if (title) seenTitles.add(title.toLowerCase());

          results.push({
            id: vidId ? `fb_${vidId}` : `fb_${Date.now()}_${results.length}`,
            title: title ? title.slice(0, 100) : `Trending Facebook Video #${results.length + 1}`,
            url: cleanHref,
            thumbnail: thumb || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop&q=80',
            channel: channel || 'Facebook Watch',
            views: '🔥 Viral',
          });
        }
        return results;
      }, max);

      if (scraped && scraped.length > 0) {
        console.log(`✅ Scraped ${scraped.length} unique live Facebook trending videos!`);
        if (scraped.length >= max) {
          return scraped.slice(0, max);
        }
        // Fill remaining slots with distinct fallback items
        const fallbacks = (FALLBACK_TRENDING[code] || FALLBACK_TRENDING.DEFAULT).map((item, i) => ({
          id: `fb_fallback_${code}_${i}`,
          title: item.title,
          url: `https://www.facebook.com/search/videos/?q=${encodeURIComponent(item.query)}`,
          thumbnail: item.thumb,
          channel: `${item.channel} • Facebook IN`,
          views: '🔥 Popular in India',
        }));
        const combined = [...scraped];
        for (const fb of fallbacks) {
          if (combined.length >= max) break;
          if (!combined.some(c => c.title === fb.title)) {
            combined.push(fb);
          }
        }
        return combined;
      }
    } catch (scrapeErr) {
      console.warn(`⚠️ Puppeteer Facebook scrape fallback: ${scrapeErr.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // 2. High Quality HD Previews Fallback
  const list = FALLBACK_TRENDING[code] || FALLBACK_TRENDING.DEFAULT;
  return list.slice(0, max).map((item, i) => ({
    id: `fb_${code}_${i}`,
    title: item.title,
    url: `https://www.facebook.com/search/videos/?q=${encodeURIComponent(item.query)}`,
    thumbnail: item.thumb,
    channel: `${item.channel} • Facebook IN`,
    views: '🔥 Popular in India',
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
