// ============================================================
// platforms/reddit.js — Reddit via snoowrap (official API) & Multi-Accounts
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Country → popular subreddits mapping
const COUNTRY_SUBREDDITS = {
  US: ['popular', 'news', 'worldnews', 'AskAmerica'],
  GB: ['unitedkingdom', 'CasualUK', 'AskUK'],
  AU: ['australia', 'AustralianPolitics'],
  CA: ['canada', 'onguardforthee'],
  ID: ['indonesia', 'Bali'],
  BR: ['brasil', 'desabafos'],
  MX: ['mexico', 'mexico_politics'],
  IN: ['india', 'IndiaSpeaks', 'IndiaUnited'],
  PH: ['Philippines', 'phclassifieds'],
  MY: ['malaysia', 'MalaysiaFi'],
  SG: ['singapore', 'singaporefi'],
  TH: ['Thailand', 'bangkokbad'],
  VN: ['vietnam', 'VietNam'],
  PK: ['pakistan', 'karachi'],
  BD: ['bangladesh'],
  JP: ['japan', 'japanlife'],
  KR: ['korea', 'hanguk'],
  DE: ['de', 'germany', 'ich_iel'],
  FR: ['france', 'francais'],
  IT: ['italy', 'italyincontresti'],
  ES: ['spain', 'es'],
  NL: ['Netherlands', 'DutchFIRE'],
  TR: ['Turkey', 'Turkiye'],
  RU: ['russia', 'russian'],
  SA: ['saudiarabia'],
  AE: ['dubai', 'UAE'],
  EG: ['egypt'],
  NG: ['Nigeria', 'lagos'],
  ZA: ['southafrica', 'capetown'],
  KE: ['Kenya', 'Nairobi'],
  AR: ['argentina', 'argentina_adult'],
  CO: ['colombia'],
  CL: ['chile'],
  PE: ['peru'],
  DEFAULT: ['popular', 'worldnews'],
};

const META = {
  id:     'reddit',
  name:   'Reddit',
  icon:   '🟠',
  color:  '#ff4500',
  accent: '#ff4500',
  supportsTrending: true,
  credentialFields: [
    { key: 'REDDIT_CLIENT_ID',     label: 'Client ID',     type: 'text',     placeholder: 'From reddit.com/prefs/apps' },
    { key: 'REDDIT_CLIENT_SECRET', label: 'Client Secret', type: 'password', placeholder: '••••••••••••••••' },
    { key: 'REDDIT_USERNAME',      label: 'Username',      type: 'text',     placeholder: 'your_reddit_username' },
    { key: 'REDDIT_PASSWORD',      label: 'Password',      type: 'password', placeholder: '••••••••' },
  ],
};

// ─── Multi-Account Storage & Rotation ────────────────────────
function getAccountsDir() {
  const dir = path.join(__dirname, '..', 'tokens', 'reddit_accounts');
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
      const hasCreds = !!(acc.username && acc.password && acc.clientId && acc.clientSecret);

      list.push({
        id: acc.id || f.replace('.json', ''),
        name: acc.name || acc.username || f.replace('.json', ''),
        username: acc.username ? `u/${acc.username}` : '',
        clientIdMasked: acc.clientId ? `${acc.clientId.slice(0, 4)}...` : 'N/A',
        postsCount: acc.postsCount || 0,
        addedAt: acc.addedAt || stat.birthtime.toISOString(),
        lastUsed: acc.lastUsed || stat.mtime.toISOString(),
        valid: hasCreds && acc.status !== 'expired',
        status: acc.status || (hasCreds ? 'active' : 'invalid'),
      });
    } catch {}
  }

  // Include .env default if set and not duplicate
  if (isEnvConfigured() && !list.some(a => a.id === 'env_default')) {
    list.unshift({
      id: 'env_default',
      name: `Primary (u/${process.env.REDDIT_USERNAME || 'default'})`,
      username: process.env.REDDIT_USERNAME ? `u/${process.env.REDDIT_USERNAME}` : 'ENV',
      clientIdMasked: process.env.REDDIT_CLIENT_ID ? `${process.env.REDDIT_CLIENT_ID.slice(0, 4)}...` : 'N/A',
      postsCount: 0,
      addedAt: new Date().toISOString(),
      lastUsed: null,
      valid: true,
      status: 'active',
    });
  }

  return list;
}

function saveAccount(name, credentials) {
  const safeName = (name || credentials.username || 'Reddit Account').trim();
  const id = 'rd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const accountData = {
    id,
    name: safeName,
    username: (credentials.username || '').replace(/^u\//, ''),
    password: credentials.password || credentials.REDDIT_PASSWORD || '',
    clientId: credentials.clientId || credentials.REDDIT_CLIENT_ID || '',
    clientSecret: credentials.clientSecret || credentials.REDDIT_CLIENT_SECRET || '',
    userAgent: credentials.userAgent || `botAdmin/2.0 by u/${(credentials.username || 'botadmin').replace(/^u\//, '')}`,
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
  const list = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data.status !== 'expired' && data.username && data.clientId) list.push(data);
    } catch {}
  }

  if (list.length === 0) {
    if (isEnvConfigured()) {
      return {
        id: 'env_default',
        name: process.env.REDDIT_USERNAME || 'Default',
        username: process.env.REDDIT_USERNAME,
        password: process.env.REDDIT_PASSWORD,
        clientId: process.env.REDDIT_CLIENT_ID,
        clientSecret: process.env.REDDIT_CLIENT_SECRET,
        userAgent: process.env.REDDIT_USER_AGENT || 'botAdmin/1.0 by u/botadmin',
      };
    }
    return null;
  }

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

function isEnvConfigured() {
  return !!(
    process.env.REDDIT_CLIENT_ID &&
    process.env.REDDIT_CLIENT_SECRET &&
    process.env.REDDIT_USERNAME &&
    process.env.REDDIT_PASSWORD
  );
}

function isConfigured() {
  const accounts = getAccountsList();
  return accounts.length > 0 || isEnvConfigured();
}

function getClient(account = null) {
  const Snoowrap = require('snoowrap');
  const acc = account || getActiveAccount();
  if (!acc) throw new Error('No active Reddit accounts or credentials found.');

  return new Snoowrap({
    userAgent:    acc.userAgent || `botAdmin/2.0 by u/${acc.username}`,
    clientId:     acc.clientId,
    clientSecret: acc.clientSecret,
    username:     acc.username,
    password:     acc.password,
  });
}

function extractSubmissionId(url) {
  // https://www.reddit.com/r/subreddit/comments/SUBMISSIONID/title/
  const match = url.match(/\/comments\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

async function postComment(threadUrl, comment) {
  if (!isConfigured()) throw new Error('Reddit credentials not configured — add an account in the Accounts tab');

  const submissionId = extractSubmissionId(threadUrl);
  if (!submissionId) throw new Error('Invalid Reddit URL — must be a thread link (contains /comments/)');

  const activeAccount = getActiveAccount();
  const r          = getClient(activeAccount);
  const submission = r.getSubmission(submissionId);
  const reply      = await submission.reply(comment);

  recordAccountPost(activeAccount?.id);
  return { success: true, commentId: reply.id, platform: 'reddit', account: activeAccount?.name };
}

async function getTrending(regionCode = 'US', maxResults = 20) {
  if (!isConfigured()) throw new Error('Reddit credentials not configured');

  const r        = getClient();
  const subs     = COUNTRY_SUBREDDITS[regionCode] || COUNTRY_SUBREDDITS.DEFAULT;
  const perSub   = Math.ceil(maxResults / subs.length);
  const allPosts = [];

  for (const sub of subs.slice(0, 3)) {
    try {
      const hot = await r.getSubreddit(sub).getHot({ limit: perSub });
      hot.forEach(post => {
        allPosts.push({
          id:        post.id,
          title:     post.title,
          url:       `https://www.reddit.com${post.permalink}`,
          thumbnail: post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : '',
          channel:   `r/${post.subreddit_name_prefixed.replace('r/', '')}`,
          views:     `${Number(post.score).toLocaleString()} upvotes · ${post.num_comments} comments`,
        });
      });
    } catch (err) {
      console.warn(`Reddit: failed to fetch r/${sub} —`, err.message);
    }
  }

  return allPosts.slice(0, maxResults);
}

async function testConnection() {
  const activeAccount = getActiveAccount();
  if (!activeAccount) {
    return { ok: false, message: 'No Reddit accounts configured' };
  }
  try {
    const r  = getClient(activeAccount);
    const me = await r.getMe();
    return { ok: true, message: `Connected as u/${me.name} (${activeAccount.name})` };
  } catch (err) {
    return { ok: false, message: `API error: ${err.message}` };
  }
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
