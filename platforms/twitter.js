// ============================================================
// platforms/twitter.js — Twitter / X via official API v2 & Multi-Accounts
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const META = {
  id:     'twitter',
  name:   'Twitter / X',
  icon:   '🐦',
  color:  '#000000',
  accent: '#1d9bf0',
  supportsTrending: true,
  credentialFields: [
    { key: 'TWITTER_API_KEY',       label: 'API Key',           type: 'text',     placeholder: 'xxxxxxxxxxxxxxxxxxxxxx' },
    { key: 'TWITTER_API_SECRET',    label: 'API Secret',        type: 'password', placeholder: '••••••••••••••••' },
    { key: 'TWITTER_ACCESS_TOKEN',  label: 'Access Token',      type: 'text',     placeholder: '0000000-xxxxxxxxxxxxx' },
    { key: 'TWITTER_ACCESS_SECRET', label: 'Access Token Secret', type: 'password', placeholder: '••••••••••••••••' },
  ],
};

// ─── Multi-Account Storage & Rotation ────────────────────────
function getAccountsDir() {
  const dir = path.join(__dirname, '..', 'tokens', 'twitter_accounts');
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
      const hasKeys = !!(acc.apiKey && acc.apiSecret && acc.accessToken && acc.accessSecret);

      list.push({
        id: acc.id || f.replace('.json', ''),
        name: acc.name || acc.username || f.replace('.json', ''),
        username: acc.username || '',
        apiKeyMasked: acc.apiKey ? `${acc.apiKey.slice(0, 4)}...${acc.apiKey.slice(-3)}` : 'N/A',
        postsCount: acc.postsCount || 0,
        addedAt: acc.addedAt || stat.birthtime.toISOString(),
        lastUsed: acc.lastUsed || stat.mtime.toISOString(),
        valid: hasKeys && acc.status !== 'expired',
        status: acc.status || (hasKeys ? 'active' : 'invalid'),
      });
    } catch {}
  }

  // Include .env default if set and not duplicate
  if (isEnvConfigured() && !list.some(a => a.id === 'env_default')) {
    list.unshift({
      id: 'env_default',
      name: 'Default (.env API)',
      username: 'ENV Profile',
      apiKeyMasked: process.env.TWITTER_API_KEY ? `${process.env.TWITTER_API_KEY.slice(0, 4)}...` : 'N/A',
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
  const safeName = (name || credentials.username || 'X Account').trim();
  const id = 'tw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const accountData = {
    id,
    name: safeName,
    username: credentials.username || '',
    apiKey: credentials.apiKey || credentials.TWITTER_API_KEY || '',
    apiSecret: credentials.apiSecret || credentials.TWITTER_API_SECRET || '',
    accessToken: credentials.accessToken || credentials.TWITTER_ACCESS_TOKEN || '',
    accessSecret: credentials.accessSecret || credentials.TWITTER_ACCESS_SECRET || '',
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
      if (data.status !== 'expired' && data.apiKey && data.accessToken) list.push(data);
    } catch {}
  }

  if (list.length === 0) {
    if (isEnvConfigured()) {
      return {
        id: 'env_default',
        name: 'Default (.env)',
        apiKey: process.env.TWITTER_API_KEY,
        apiSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
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
    process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_SECRET
  );
}

function isConfigured() {
  const accounts = getAccountsList();
  return accounts.length > 0 || isEnvConfigured();
}

function getClient(account = null) {
  const { TwitterApi } = require('twitter-api-v2');
  const acc = account || getActiveAccount();
  if (!acc) throw new Error('No active Twitter / X credentials found.');

  return new TwitterApi({
    appKey:       acc.apiKey,
    appSecret:    acc.apiSecret,
    accessToken:  acc.accessToken,
    accessSecret: acc.accessSecret,
  });
}

function extractTweetId(url) {
  if (!url) return null;
  const str = String(url).trim();
  if (/^\d{15,25}$/.test(str)) return str;
  const match = str.match(/status\/(\d+)/);
  return match ? match[1] : null;
}

async function postComment(tweetUrl, comment) {
  if (!isConfigured()) throw new Error('Twitter credentials not configured — add an account in the Accounts tab');

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) throw new Error('Invalid Twitter/X URL — must contain /status/TWEETID');

  const activeAccount = getActiveAccount();
  const client = getClient(activeAccount);

  const { data } = await client.v2.reply(comment, tweetId);
  recordAccountPost(activeAccount?.id);
  const replyUrl = data?.id ? `https://x.com/i/web/status/${data.id}` : tweetUrl;
  return { success: true, tweetId: data.id, url: replyUrl, commentUrl: replyUrl, platform: 'twitter', account: activeAccount?.name };
}

async function testConnection() {
  const activeAccount = getActiveAccount();
  if (!activeAccount) {
    return { ok: false, message: 'No Twitter / X accounts configured' };
  }
  try {
    const client = getClient(activeAccount);
    const { data } = await client.v2.me();
    return { ok: true, message: `Connected as @${data.username} (${activeAccount.name})` };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('403') || msg.includes('Forbidden')) {
      return { ok: false, message: 'API keys valid but Write access denied — upgrade to X Basic' };
    }
    return { ok: false, message: `API error: ${msg}` };
  }
}

const TRENDS24_COUNTRY_MAP = {
  US: 'united-states',
  GB: 'united-kingdom',
  IN: 'india',
  ID: 'indonesia',
  BR: 'brazil',
  MX: 'mexico',
  CA: 'canada',
  AU: 'australia',
  DE: 'germany',
  FR: 'france',
  IT: 'italy',
  ES: 'spain',
  JP: 'japan',
  KR: 'korea',
  PH: 'philippines',
  MY: 'malaysia',
  SG: 'singapore',
  TH: 'thailand',
  NG: 'nigeria',
  ZA: 'south-africa',
};

async function getTrending(regionCode = 'US', maxResults = 20) {
  const code = (regionCode || 'US').toUpperCase();
  const countrySlug = TRENDS24_COUNTRY_MAP[code] || 'united-states';
  const url = `https://trends24.in/${countrySlug}/`;

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      timeout: 10000,
    });
    const html = res.data;
    const regex = /<a[^>]+href="(https:\/\/twitter\.com\/search\?q=[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    const trends = [];
    const seen = new Set();
    let match;

    while ((match = regex.exec(html)) !== null && trends.length < maxResults) {
      const topicUrl = match[1].replace(/&amp;/g, '&');
      const topicName = match[2].trim();
      if (!seen.has(topicName) && topicName.length > 1) {
        seen.add(topicName);
        trends.push({
          id: `tw_${trends.length}`,
          title: topicName,
          url: topicUrl,
          thumbnail: 'https://abs.twimg.com/favicons/twitter.3.ico',
          channel: `Twitter / X Trends • ${code}`,
          views: '🔥 Trending Topic',
        });
      }
    }
    return trends;
  } catch (err) {
    return [
      {
        id: 'tw_fallback_1',
        title: '#TrendingNow — Explore Top X Discussions',
        url: 'https://twitter.com/explore',
        thumbnail: 'https://abs.twimg.com/favicons/twitter.3.ico',
        channel: 'Twitter Explore',
        views: '🔥 Top Trends',
      }
    ];
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
