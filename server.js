// ============================================================
// 🤖 YouTube Bot — Admin Panel Server (Multi-Platform)
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { google } = require('googleapis');
const { OpenAI } = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const cors = require('cors');

// ─── Simple In-Memory Rate Limiter ────────────────────────────
const authAttempts = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_MAX = 5;       // max attempts
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true; // allowed
  }
  if (entry.count >= RATE_LIMIT_MAX) return false; // blocked
  entry.count++;
  return true;
}

function clearRateLimit(ip) {
  authAttempts.delete(ip);
}

// ─── Platform Modules ─────────────────────────────────────────
const platformYoutube   = require('./platforms/youtube');
const platformTikTok    = require('./platforms/tiktok');
const platformInstagram = require('./platforms/instagram');
const platformTwitter   = require('./platforms/twitter');
const platformReddit    = require('./platforms/reddit');
const platformFacebook  = require('./platforms/facebook');
const platformTelegram  = require('./platforms/telegram');
const telegramSeo       = require('./telegram_seo');

const PLATFORM_REGISTRY = {
  youtube:   platformYoutube,
  tiktok:    platformTikTok,
  instagram: platformInstagram,
  twitter:   platformTwitter,
  reddit:    platformReddit,
  facebook:  platformFacebook,
  telegram:  platformTelegram,
};
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── App Setup ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Socket.io authentication middleware
  allowRequest: (req, callback) => {
    const token = req.headers['x-admin-token'] || new URL(req.url, 'http://localhost').searchParams.get('token');
    if (!token) return callback(null, false);
    try {
      const decoded = Buffer.from(token, 'base64').toString('utf-8');
      callback(null, decoded === (process.env.ADMIN_PASSWORD || 'admin123'));
    } catch {
      callback(null, false);
    }
  },
});
const PORT = process.env.ADMIN_PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Countries Persistence ──────────────────────────────────
const COUNTRIES_FILE = path.join(__dirname, 'countries.json');

const DEFAULT_COUNTRIES = [
  { code: 'ID', name: 'Indonesia',       flag: '🇮🇩', language: 'Indonesian' },
  { code: 'US', name: 'United States',   flag: '🇺🇸', language: 'English' },
  { code: 'GB', name: 'United Kingdom',  flag: '🇬🇧', language: 'English' },
  { code: 'AU', name: 'Australia',       flag: '🇦🇺', language: 'English' },
  { code: 'CA', name: 'Canada',          flag: '🇨🇦', language: 'English' },
  { code: 'BR', name: 'Brazil',          flag: '🇧🇷', language: 'Portuguese (Brazilian)' },
  { code: 'PT', name: 'Portugal',        flag: '🇵🇹', language: 'Portuguese' },
  { code: 'MX', name: 'Mexico',          flag: '🇲🇽', language: 'Spanish' },
  { code: 'ES', name: 'Spain',           flag: '🇪🇸', language: 'Spanish' },
  { code: 'AR', name: 'Argentina',       flag: '🇦🇷', language: 'Spanish' },
  { code: 'CO', name: 'Colombia',        flag: '🇨🇴', language: 'Spanish' },
  { code: 'CL', name: 'Chile',           flag: '🇨🇱', language: 'Spanish' },
  { code: 'PE', name: 'Peru',            flag: '🇵🇪', language: 'Spanish' },
  { code: 'MY', name: 'Malaysia',        flag: '🇲🇾', language: 'Malay' },
  { code: 'PH', name: 'Philippines',     flag: '🇵🇭', language: 'Filipino' },
  { code: 'TH', name: 'Thailand',        flag: '🇹🇭', language: 'Thai' },
  { code: 'VN', name: 'Vietnam',         flag: '🇻🇳', language: 'Vietnamese' },
  { code: 'SG', name: 'Singapore',       flag: '🇸🇬', language: 'English' },
  { code: 'IN', name: 'India (Hindi)',   flag: '🇮🇳', language: 'Hindi' },
  { code: 'IN-HG', name: 'India (Hinglish)', flag: '🇮🇳', language: 'Hinglish (Hindi written in Roman English alphabet)' },
  { code: 'PK', name: 'Pakistan',        flag: '🇵🇰', language: 'Urdu' },
  { code: 'BD', name: 'Bangladesh',      flag: '🇧🇩', language: 'Bengali' },
  { code: 'JP', name: 'Japan',           flag: '🇯🇵', language: 'Japanese' },
  { code: 'KR', name: 'South Korea',     flag: '🇰🇷', language: 'Korean' },
  { code: 'SA', name: 'Saudi Arabia',    flag: '🇸🇦', language: 'Arabic' },
  { code: 'AE', name: 'UAE',             flag: '🇦🇪', language: 'Arabic' },
  { code: 'EG', name: 'Egypt',           flag: '🇪🇬', language: 'Arabic' },
  { code: 'MA', name: 'Morocco',         flag: '🇲🇦', language: 'Arabic' },
  { code: 'DZ', name: 'Algeria',         flag: '🇩🇿', language: 'Arabic' },
  { code: 'TR', name: 'Turkey',          flag: '🇹🇷', language: 'Turkish' },
  { code: 'RU', name: 'Russia',          flag: '🇷🇺', language: 'Russian' },
  { code: 'UA', name: 'Ukraine',         flag: '🇺🇦', language: 'Ukrainian' },
  { code: 'DE', name: 'Germany',         flag: '🇩🇪', language: 'German' },
  { code: 'FR', name: 'France',          flag: '🇫🇷', language: 'French' },
  { code: 'IT', name: 'Italy',           flag: '🇮🇹', language: 'Italian' },
  { code: 'NL', name: 'Netherlands',     flag: '🇳🇱', language: 'Dutch' },
  { code: 'PL', name: 'Poland',          flag: '🇵🇱', language: 'Polish' },
  { code: 'SE', name: 'Sweden',          flag: '🇸🇪', language: 'Swedish' },
  { code: 'NO', name: 'Norway',          flag: '🇳🇴', language: 'Norwegian' },
  { code: 'FI', name: 'Finland',         flag: '🇫🇮', language: 'Finnish' },
  { code: 'DK', name: 'Denmark',         flag: '🇩🇰', language: 'Danish' },
  { code: 'GR', name: 'Greece',          flag: '🇬🇷', language: 'Greek' },
  { code: 'RO', name: 'Romania',         flag: '🇷🇴', language: 'Romanian' },
  { code: 'CZ', name: 'Czech Republic',  flag: '🇨🇿', language: 'Czech' },
  { code: 'HU', name: 'Hungary',         flag: '🇭🇺', language: 'Hungarian' },
  { code: 'IL', name: 'Israel',          flag: '🇮🇱', language: 'Hebrew' },
  { code: 'NG', name: 'Nigeria',         flag: '🇳🇬', language: 'English' },
  { code: 'KE', name: 'Kenya',           flag: '🇰🇪', language: 'Swahili' },
  { code: 'GH', name: 'Ghana',           flag: '🇬🇭', language: 'English' },
  { code: 'ZA', name: 'South Africa',    flag: '🇿🇦', language: 'English' },
  { code: 'TZ', name: 'Tanzania',        flag: '🇹🇿', language: 'Swahili' },
];

function loadCountries() {
  try {
    if (fs.existsSync(COUNTRIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(COUNTRIES_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (err) {
    console.error('Failed to read countries.json:', err.message);
  }
  saveCountries(DEFAULT_COUNTRIES);
  return DEFAULT_COUNTRIES;
}

function saveCountries(list) {
  try {
    fs.writeFileSync(COUNTRIES_FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to write countries.json:', err.message);
    return false;
  }
}

let COUNTRIES = loadCountries();

// ─── Logging ─────────────────────────────────────────────────
const logs = [];
const MAX_LOGS = 300;

function log(level, message) {
  const entry = { level, message, timestamp: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  io.emit('log', entry);
  if (level === 'error') process.stderr.write(message + '\n');
  else process.stdout.write(message + '\n');
}

// ─── .env File Writer ────────────────────────────────────────────
function updateEnvFile(updates, singleVal) {
  if (typeof updates === 'string') {
    updates = { [updates]: singleVal };
  }
  if (!updates || typeof updates !== 'object') return;
  const envPath = path.join(__dirname, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue; 
    const regex = new RegExp(`^${key}=.*`, 'gm');
    const line  = `${key}=${value}`;
    if (regex.test(content)) {
      content = content.replace(regex, () => line);
    } else {
      content += (content.endsWith('\n') || content === '' ? '' : '\n') + `${key}=${value}\n`;
    }
    process.env[key] = String(value);
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

const botLog   = (msg) => log('info',    msg);
const botWarn  = (msg) => log('warn',    msg);
const botError = (msg) => log('error',   msg);
const botOk    = (msg) => log('success', msg);

// ─── Environment ──────────────────────────────────────────────
let openaiApiKey    = process.env.OPENAI_API_KEY;
let CLIENT_ID       = process.env.GOOGLE_CLIENT_ID;
let CLIENT_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
let REDIRECT_URI    = process.env.GOOGLE_REDIRECT_URI;
let YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
let PROXYLAB_HOST   = process.env.PROXYLAB_HOST   || 'proxy.proxylab.io';
let PROXYLAB_PORT   = process.env.PROXYLAB_PORT   || '8080';
let PROXYLAB_USERNAME = process.env.PROXYLAB_USERNAME;
let PROXYLAB_PASSWORD = process.env.PROXYLAB_PASSWORD;
let PROXYLAB_ENABLED  = process.env.PROXYLAB_ENABLED === 'true';

let openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// ─── Telegram Notifications ───────────────────────────────────
async function sendTelegram(message) {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;
  const enabled = process.env.TELEGRAM_NOTIFY_ENABLED === 'true';
  if (!enabled || !token || !groupId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    groupId,
      text:       message,
      parse_mode: 'HTML',
    });
  } catch (err) {
    botWarn(`⚠️ Telegram notify failed: ${err.message}`);
  }
}


// ─── Stats ───────────────────────────────────────────────────
const stats = {
  startTime:       Date.now(),
  commentsPosted:  0,
  lastCommentTime: null,
  commentHistory:  [],
  platformStats:   { youtube: 0, tiktok: 0, instagram: 0, twitter: 0, reddit: 0, facebook: 0, telegram: 0 },
};

// ─── Proxy ───────────────────────────────────────────────────
function generateProxy() {
  if (!PROXYLAB_ENABLED || !PROXYLAB_USERNAME || !PROXYLAB_PASSWORD) return null;
  return `http://${PROXYLAB_USERNAME}:${PROXYLAB_PASSWORD}@${PROXYLAB_HOST}:${PROXYLAB_PORT}`;
}

// ─── Load Accounts ───────────────────────────────────────────
let users = [];
let accountStats = {}; // username -> { commentsPosted, lastUsed, status }

function loadUsers() {
  try {
    if (!fs.existsSync('tokens')) {
      botWarn('⚠️ tokens/ directory not found. No accounts loaded.');
      return [];
    }
    const tokenFiles = fs.readdirSync('tokens').filter(f => f.endsWith('.json') && !f.includes('tiktok') && !f.includes('facebook'));
    if (tokenFiles.length === 0) {
      botWarn('⚠️ No YouTube token files found. Go to Accounts tab to add YouTube accounts.');
      return [];
    }

    return tokenFiles.map(file => {
      const username = file.replace('.json', '');
      try {
        const credentials = JSON.parse(fs.readFileSync(`tokens/${file}`));
        if (!credentials || (!credentials.access_token && !credentials.refresh_token)) {
          return null;
        }
        const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
        oauth2Client.setCredentials(credentials);

        const proxyUrl = generateProxy();
        let agent = null;
        if (proxyUrl) {
          agent = new HttpsProxyAgent(proxyUrl);
          // Patch the oauth2 client transporter to use the proxy
          oauth2Client.transporter = {
            request: (opts) => {
              const client = axios.create({ httpsAgent: agent, proxy: false });
              return client.request({
                url: opts.url, method: opts.method,
                headers: opts.headers, data: opts.data,
                params: opts.params, responseType: 'json',
              });
            }
          };
          botOk(`✅ Loaded ${username} with ProxyLab`);
        } else {
          botWarn(`⚠️ Loaded ${username} (no proxy)`);
        }

        if (!accountStats[username]) {
          accountStats[username] = { commentsPosted: 0, lastUsed: null, status: 'idle' };
        }

        return {
          username,
          auth: oauth2Client,
          credentials,
          agent,
          youtube: google.youtube({ version: 'v3', auth: oauth2Client }),
        };
      } catch (err) {
        botError(`❌ Failed to load ${username}: ${err.message}`);
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    botError(`❌ Error loading accounts: ${err.message}`);
    return [];
  }
}

users = loadUsers();

// ─── Bot Helpers ─────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractVideoId(url) {
  if (!url) return null;
  const str = String(url).trim();
  // Direct 11-char ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
  // Support youtube.com (watch, shorts, live, embed) and youtu.be
  const regex = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?(?:.*&)?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = str.match(regex);
  return match ? match[1] : null;
}

async function refreshAccessToken(user) {
  try {
    if (!user.auth.credentials?.refresh_token) {
      botError(`❌ No refresh token for ${user.username}`);
      return;
    }
    botLog(`🔄 Refreshing token for ${user.username}...`);
    const { credentials } = await user.auth.refreshAccessToken();
    user.auth.setCredentials(credentials);
    credentials.refresh_token = user.auth.credentials.refresh_token;
    fs.writeFileSync(`tokens/${user.username}.json`, JSON.stringify(credentials, null, 2));
    botOk(`🔑 Token refreshed for ${user.username}`);
  } catch (err) {
    botError(`❌ Token refresh failed for ${user.username}: ${err.message}`);
  }
}

async function getCommentsOrMetadata(videoId, youtube) {
  try {
    const res = await youtube.commentThreads.list({ part: 'snippet', videoId, maxResults: 50 });
    const comments = res.data.items?.map(i => i.snippet.topLevelComment.snippet.textOriginal) || [];
    if (comments.length > 0) return { type: 'comments', data: comments };
    const videoRes = await youtube.videos.list({ part: 'snippet', id: videoId });
    const video = videoRes.data.items?.[0]?.snippet;
    const combined = `${video?.title || ''}\n${video?.description || ''}`.trim();
    return { type: 'metadata', data: combined || 'a YouTube video' };
  } catch (err) {
    botError(`❌ Error fetching video data: ${err.message}`);
    return { type: 'fallback', data: 'a YouTube video' };
  }
}

// ─── Text Obfuscation ────────────────────────────────────────
function randomFont(char) {
  const fonts = [
    { offset: 0x1D400 - 65, onlyCaps: true  },
    { offset: 0x1D41A - 97, onlyCaps: false },
    { offset: 0x1D434 - 65, onlyCaps: true  },
    { offset: 0x1D44E - 97, onlyCaps: false },
    { offset: 0x1D468 - 65, onlyCaps: true  },
    { offset: 0x1D482 - 97, onlyCaps: false },
  ];
  const set   = fonts[Math.floor(Math.random() * fonts.length)];
  const code  = char.charCodeAt(0);
  if (/[A-Z]/.test(char) && set.onlyCaps)  return String.fromCodePoint(set.offset + (code - 65));
  if (/[a-z]/.test(char) && !set.onlyCaps) return String.fromCodePoint(set.offset + (code - 97));
  return char;
}

function obfuscateKeyword(text, keyword) {
  const zeroWidth  = '\u200b';
  const randomChars = ['*', '!'];
  const obfuscated  = keyword.split('')
    .map(char => {
      if (Math.random() < 0.01) {
        const styled = randomFont(char);
        const r = Math.random() < 0.5 ? zeroWidth : randomChars[Math.floor(Math.random() * randomChars.length)];
        return `${styled}${r}`;
      }
      return char;
    })
    .join(' ');
  const bolded = `**${obfuscated}**`;
  return text.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), bolded);
}

function injectRandomEmojis(text, niche = 'gambling') {
  const sets = {
    default:  ['🔥','🚀','💯','🎯','✨','📈','🤖','🧠','💥','🎲'],
    gambling: ['🎰','💸','🍀','💰','🤑','🎲','🃏','🎯'],
    crypto:   ['🪙','📉','📈','🚀','💰','🔐','🤖'],
  };
  const emojis = sets[niche] || sets.default;
  return text.split(' ')
    .map(w => Math.random() < 0.1 ? `${w} ${emojis[Math.floor(Math.random() * emojis.length)]}` : w)
    .join(' ');
}

function randomizeStyle(reply) {
  const styles = [
    (r) => r,
    (r) => `"${r}" 👀`,
    (r) => `🔥 ${r}`,
    (r) => `${r} 😂💯`,
    (r) => `${r.split(' ').map(w => w.toUpperCase()).join(' ')} 💥`,
    (r) => `${r} 🤔 what do y'all think?`,
  ];
  return styles[Math.floor(Math.random() * styles.length)](reply);
}

// ─── AI Comment Generation (country-aware) ───────────────────
const KEYWORDS_FILE = path.join(__dirname, 'keywords.json');

function loadKeywords() {
  try {
    if (fs.existsSync(KEYWORDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (e) {
    console.warn('⚠️ Error reading keywords.json:', e.message);
  }
  return ['TEENPATTISTARS', 'TPS', 'S777'];
}

function saveKeywords(kwList) {
  try {
    fs.writeFileSync(KEYWORDS_FILE, JSON.stringify(kwList, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ Error writing keywords.json:', e.message);
  }
}

let keywords = loadKeywords();

async function generateReply(input, sourceType, language = 'Indonesian', useKeyword = true) {
  try {
    const chosenKeyword = keywords[Math.floor(Math.random() * keywords.length)];
    if (!openai) {
      botWarn('⚠️ OpenAI API key not configured. Using fallback comment template.');
      const fallbackText = useKeyword ? `Nice video! #${chosenKeyword}` : 'Great video!';
      let fallbackReply = useKeyword
        ? injectRandomEmojis(obfuscateKeyword(fallbackText, chosenKeyword), 'gambling')
        : fallbackText;
      return randomizeStyle(fallbackReply);
    }

    let prompt;
    if (useKeyword) {
      prompt = sourceType === 'comments'
        ? `Respond casually and naturally to this YouTube comment like a real viewer. Write ONLY in ${language} language. Make it one sentence, avoid generic phrases like "thanks" or "great video". Subtly mention the keyword #${chosenKeyword} at the end. Comment: "${input}"`
        : `Write a short, natural-sounding one-sentence YouTube comment about this video. Write ONLY in ${language} language. Avoid generic praise. Make it feel like a real viewer reaction. Subtly mention the keyword #${chosenKeyword} at the end. Video info: "${input}"`;
    } else {
      prompt = sourceType === 'comments'
        ? `Respond casually and naturally to this YouTube comment like a real viewer. Write ONLY in ${language} language. Make it one sentence, avoid generic phrases like "thanks" or "great video". Do NOT mention any brand, keyword, or hashtag. Comment: "${input}"`
        : `Write a short, natural-sounding one-sentence YouTube comment about this video. Write ONLY in ${language} language. Avoid generic praise. Make it feel like a real viewer reaction. No brand names or hashtags at all. Video info: "${input}"`;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });

    let reply = response.choices[0]?.message?.content?.trim();
    if (!reply || reply.length < 3) reply = useKeyword ? `Nice content. #${chosenKeyword}` : 'Nice content!';
    if (useKeyword) {
      reply = obfuscateKeyword(reply, chosenKeyword);
      reply = injectRandomEmojis(reply, 'gambling');
    }
    reply = randomizeStyle(reply);
    return reply;
  } catch (err) {
    botError(`❌ AI generation error: ${err.message}`);
    return useKeyword
      ? injectRandomEmojis(obfuscateKeyword(`Nice content. #${keywords[0]}`, keywords[0]), 'gambling')
      : 'Great video!';
  }
}


// ─── Anti-Ban Settings ──────────────────────────────────────
let postDelay        = parseInt(process.env.POST_DELAY)        || 60000;  // ms (legacy fallback)
let postDelayMin     = parseInt(process.env.POST_DELAY_MIN)    || 60000;  // ms min random delay
let postDelayMax     = parseInt(process.env.POST_DELAY_MAX)    || 120000; // ms max random delay
let dailyLimitPerAcc = parseInt(process.env.DAILY_LIMIT_PER_ACCOUNT) || 30;
let cooldownHours    = parseFloat(process.env.ACCOUNT_COOLDOWN_HOURS) || 0;
let keywordMixRatio  = parseInt(process.env.KEYWORD_MIX_RATIO)  || 80;   // % of comments WITH keyword
let safeModeEnabled  = process.env.SAFE_MODE_ENABLED !== 'false';         // default true

// Daily stats reset at midnight
function checkDailyReset(username) {
  const s = accountStats[username];
  if (!s) return;
  const now   = new Date();
  const today = now.toDateString();
  if (s.dailyResetDate !== today) {
    s.dailyCount     = 0;
    s.dailyResetDate = today;
  }
}

function randomDelay() {
  const min = postDelayMin;
  const max = postDelayMax;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


async function postComments(videoId, language = 'Indonesian') {
  if (users.length === 0) {
    botError('❌ No accounts loaded. Cannot post comments.');
    return { success: [], failed: [] };
  }

  const firstYT = users[0].youtube;
  botLog(`🔍 Fetching video data for ${videoId}...`);
  const source = await getCommentsOrMetadata(videoId, firstYT);
  botLog(`📄 Source type: ${source.type}`);

  const success = [], failed = [], skipped = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    accountStats[user.username] = accountStats[user.username] || { commentsPosted: 0, lastUsed: null, status: 'idle', dailyCount: 0, dailyResetDate: '' };
    checkDailyReset(user.username);

    // ── Anti-Ban: daily limit check ──────────────────────────
    if (safeModeEnabled && accountStats[user.username].dailyCount >= dailyLimitPerAcc) {
      botWarn(`⏸️ [${user.username}] Daily limit (${dailyLimitPerAcc}) reached. Skipping.`);
      skipped.push(user.username);
      io.emit('accountStatus', { username: user.username, status: 'idle' });
      continue;
    }

    // ── Anti-Ban: cooldown check ──────────────────────────────
    if (safeModeEnabled && cooldownHours > 0 && accountStats[user.username].lastUsed) {
      const hoursSinceLast = (Date.now() - accountStats[user.username].lastUsed) / 3600000;
      if (hoursSinceLast < cooldownHours) {
        const waitMins = Math.ceil((cooldownHours - hoursSinceLast) * 60);
        botWarn(`⏸️ [${user.username}] Cooldown active — ${waitMins}m remaining. Skipping.`);
        skipped.push(user.username);
        io.emit('accountStatus', { username: user.username, status: 'idle' });
        continue;
      }
    }

    accountStats[user.username].status = 'posting';
    io.emit('accountStatus', { username: user.username, status: 'posting' });

    try {
      if (!user.auth?.credentials?.access_token) {
        botError(`❌ No valid credentials for ${user.username}. Skipping.`);
        failed.push(user.username);
        accountStats[user.username].status = 'error';
        io.emit('accountStatus', { username: user.username, status: 'error' });
        continue;
      }

      await refreshAccessToken(user);

      const input = source.type === 'comments'
        ? source.data[Math.floor(Math.random() * source.data.length)]
        : source.data;

      // ── Anti-Ban: keyword mixing ──────────────────────────
      const useKeyword = !safeModeEnabled || Math.random() * 100 < keywordMixRatio;
      if (!useKeyword) botLog(`🎭 [${user.username}] Posting keyword-free comment (blend-in mode)`);

      botLog(`🤖 Generating ${language} comment for ${user.username}...`);
      const reply = await generateReply(input, source.type, language, useKeyword);

      await user.youtube.commentThreads.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId,
            topLevelComment: { snippet: { textOriginal: reply } },
          },
        },
      });

      botOk(`✅ [${user.username}] Posted: "${reply.substring(0, 60)}..."`);
      success.push(user.username);
      stats.commentsPosted++;
      stats.lastCommentTime = Date.now();
      accountStats[user.username].commentsPosted = (accountStats[user.username].commentsPosted || 0) + 1;
      accountStats[user.username].dailyCount     = (accountStats[user.username].dailyCount     || 0) + 1;
      accountStats[user.username].lastUsed       = Date.now();
      accountStats[user.username].status         = 'idle';
      io.emit('accountStatus', { username: user.username, status: 'idle' });

      // Telegram notification
      sendTelegram(`✅ <b>${user.username}</b> posted a comment on YouTube\n🎬 Video: <code>${videoId}</code>\n💬 "${reply.substring(0, 100)}..."`);

      // ── Anti-Ban: random delay ────────────────────────────
      if (i < users.length - 1) {
        const waitMs = safeModeEnabled ? randomDelay() : postDelay;
        botLog(`⏳ Waiting ${(waitMs/1000).toFixed(0)}s before next account (anti-ban delay)...`);
        await delay(waitMs);
      }
    } catch (err) {
      botError(`❌ [${user.username}] Failed: ${err.message}`);
      failed.push(user.username);
      accountStats[user.username].status = 'error';
      io.emit('accountStatus', { username: user.username, status: 'error' });
    }
  }

  const result = { success, failed, skipped };
  stats.commentHistory.unshift({ videoId, language, time: Date.now(), success: success.length, failed: failed.length, skipped: skipped.length });
  if (stats.commentHistory.length > 50) stats.commentHistory.pop();
  botOk(`🏁 Done! ✅ ${success.length} posted, ❌ ${failed.length} failed, ⏸️ ${skipped.length} skipped.`);
  return result;
}

// ─── Trending Videos ─────────────────────────────────────────
async function getTrendingVideos(regionCode = 'ID', maxResults = 20) {
  const apiKey = process.env.YOUTUBE_API_KEY || YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: {
          part: 'snippet,statistics',
          chart: 'mostPopular',
          regionCode: (regionCode || 'US').substring(0, 2),
          maxResults,
          key: apiKey,
        },
        timeout: 10000,
      });
      return (response.data.items || []).map(video => ({
        id:          video.id,
        title:       video.snippet.title,
        channel:     video.snippet.channelTitle,
        thumbnail:   video.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
        views:       Number(video.statistics?.viewCount || 0).toLocaleString(),
        url:         `https://www.youtube.com/watch?v=${video.id}`,
        publishedAt: video.snippet.publishedAt,
      }));
    } catch (err) {
      botWarn(`⚠️ Trending via API key failed (${err.message}), trying user accounts...`);
    }
  }

  if (users.length > 0) {
    const youtube = users[0].youtube;
    const response = await youtube.videos.list({
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode,
      maxResults,
    });
    return (response.data.items || []).map(video => ({
      id:          video.id,
      title:       video.snippet.title,
      channel:     video.snippet.channelTitle,
      thumbnail:   video.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
      views:       Number(video.statistics?.viewCount || 0).toLocaleString(),
      url:         `https://www.youtube.com/watch?v=${video.id}`,
      publishedAt: video.snippet.publishedAt,
    }));
  }

  throw new Error('No YouTube accounts loaded and no YOUTUBE_API_KEY configured in Settings');
}

// ─── Auth Middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    if (decoded !== ADMIN_PASSWORD) throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ─── API Routes ───────────────────────────────────────────────

// Auth (rate-limited)
app.post('/api/auth', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    botWarn(`🚫 Rate limit hit on /api/auth from ${ip}`);
    return res.status(429).json({ success: false, message: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    clearRateLimit(ip); // Reset on successful login
    const token = Buffer.from(ADMIN_PASSWORD).toString('base64');
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

// Countries — GET, ADD/UPDATE, DELETE
app.get('/api/countries', (req, res) => {
  COUNTRIES = loadCountries();
  res.json(COUNTRIES);
});

app.post('/api/countries', requireAuth, (req, res) => {
  const { code, name, flag, language } = req.body;
  if (!code || !name) return res.status(400).json({ ok: false, error: 'Country code and name are required' });
  const cleanCode = code.toUpperCase().trim();
  const list = loadCountries();
  const existingIdx = list.findIndex(c => c.code === cleanCode);
  const countryObj = {
    code: cleanCode,
    name: name.trim(),
    flag: flag ? flag.trim() : '🌐',
    language: language ? language.trim() : 'English',
  };
  if (existingIdx >= 0) {
    list[existingIdx] = countryObj;
  } else {
    list.push(countryObj);
  }
  saveCountries(list);
  COUNTRIES = list;
  botOk(`🌍 Country saved: ${countryObj.flag} ${countryObj.name} (${countryObj.code})`);
  res.json({ ok: true, country: countryObj, countries: list });
});

app.delete('/api/countries/:code', requireAuth, (req, res) => {
  const { code } = req.params;
  const cleanCode = code.toUpperCase().trim();
  let list = loadCountries();
  const beforeLen = list.length;
  list = list.filter(c => c.code !== cleanCode);
  if (list.length < beforeLen) {
    saveCountries(list);
    COUNTRIES = list;
    botWarn(`🗑️ Deleted country: ${cleanCode}`);
    res.json({ ok: true, countries: list });
  } else {
    res.status(404).json({ ok: false, error: 'Country not found' });
  }
});

// Status / stats
app.get('/api/status', requireAuth, (req, res) => {
  const uptimeMs = Date.now() - stats.startTime;
  const hours    = Math.floor(uptimeMs / 3600000);
  const minutes  = Math.floor((uptimeMs % 3600000) / 60000);
  const seconds  = Math.floor((uptimeMs % 60000) / 1000);
  res.json({
    uptime:          `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
    uptimeMs,
    accountsLoaded:  users.length,
    commentsPosted:  stats.commentsPosted,
    lastCommentTime: stats.lastCommentTime,
    commentHistory:  stats.commentHistory,
    proxyEnabled:    PROXYLAB_ENABLED,
    startTime:       stats.startTime,
  });
});

// Config — GET current settings
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    postDelay:             postDelay,
    proxyEnabled:          PROXYLAB_ENABLED,
    proxyHost:             process.env.PROXYLAB_HOST          || '',
    proxyPort:             process.env.PROXYLAB_PORT          || '',
    proxyUsername:         process.env.PROXYLAB_USERNAME      || '',
    proxyPassword:         process.env.PROXYLAB_PASSWORD      || '',
    telegramNotifyEnabled: process.env.TELEGRAM_NOTIFY_ENABLED === 'true',
    telegramBotToken:      process.env.TELEGRAM_BOT_TOKEN     || '',
    telegramGroupId:       process.env.TELEGRAM_GROUP_ID      || '',
    openaiApiKey:          process.env.OPENAI_API_KEY         || '',
    // Google & YouTube API
    googleClientId:        process.env.GOOGLE_CLIENT_ID       || '',
    googleClientSecret:    process.env.GOOGLE_CLIENT_SECRET   || '',
    googleRedirectUri:     process.env.GOOGLE_REDIRECT_URI    || '',
    youtubeApiKey:         process.env.YOUTUBE_API_KEY        || '',
    // Anti-ban settings
    safeModeEnabled:        safeModeEnabled,
    postDelayMin:           postDelayMin,
    postDelayMax:           postDelayMax,
    dailyLimitPerAccount:   dailyLimitPerAcc,
    accountCooldownHours:   cooldownHours,
    keywordMixRatio:        keywordMixRatio,
    accountCount:           users.length,
    platformStats:          stats.platformStats,
  });
});

// Config — POST save all settings
app.post('/api/config', requireAuth, (req, res) => {
  const { postDelay: pd, proxyEnabled, proxyHost, proxyPort, proxyUsername, proxyPassword,
          telegramNotifyEnabled, telegramBotToken, telegramGroupId,
          safeModeEnabled: sm, postDelayMin: pdMin, postDelayMax: pdMax,
          dailyLimitPerAccount: dl, accountCooldownHours: ch, keywordMixRatio: kmr,
          openaiApiKey: oaiKey,
          googleClientId: gCId, googleClientSecret: gCSecret, googleRedirectUri: gRedir, youtubeApiKey: ytKey } = req.body;

  if (pd    !== undefined) { postDelay = Number(pd) || 60000; updateEnvFile('POST_DELAY', String(postDelay)); }
  if (pdMin !== undefined) { postDelayMin = Number(pdMin) || 60000;  updateEnvFile('POST_DELAY_MIN',  String(postDelayMin)); }
  if (pdMax !== undefined) { postDelayMax = Number(pdMax) || 120000; updateEnvFile('POST_DELAY_MAX',  String(postDelayMax)); }
  if (dl    !== undefined) { dailyLimitPerAcc = Number(dl) || 30;    updateEnvFile('DAILY_LIMIT_PER_ACCOUNT', String(dailyLimitPerAcc)); }
  if (ch    !== undefined) { cooldownHours    = Number(ch) || 0;     updateEnvFile('ACCOUNT_COOLDOWN_HOURS',  String(cooldownHours)); }
  if (kmr   !== undefined) { keywordMixRatio  = Number(kmr) || 80;   updateEnvFile('KEYWORD_MIX_RATIO',       String(keywordMixRatio)); }
  if (sm    !== undefined) { safeModeEnabled  = !!sm;               updateEnvFile('SAFE_MODE_ENABLED',       safeModeEnabled ? 'true' : 'false'); }

  if (oaiKey !== undefined) {
    const trimmedKey = String(oaiKey).trim();
    openaiApiKey = trimmedKey;
    updateEnvFile('OPENAI_API_KEY', trimmedKey);
    try {
      openai = trimmedKey ? new OpenAI({ apiKey: trimmedKey }) : null;
      botOk('🔑 OpenAI API Key updated and client refreshed');
    } catch (e) {
      botWarn(`⚠️ Failed to reinitialize OpenAI client: ${e.message}`);
    }
  }

  // Google & YouTube credentials
  if (gCId !== undefined) {
    const v = String(gCId).trim();
    CLIENT_ID = v;
    updateEnvFile('GOOGLE_CLIENT_ID', v);
  }
  if (gCSecret !== undefined) {
    const v = String(gCSecret).trim();
    CLIENT_SECRET = v;
    updateEnvFile('GOOGLE_CLIENT_SECRET', v);
  }
  if (gRedir !== undefined) {
    const v = String(gRedir).trim();
    REDIRECT_URI = v;
    updateEnvFile('GOOGLE_REDIRECT_URI', v);
  }
  if (ytKey !== undefined) {
    const v = String(ytKey).trim();
    YOUTUBE_API_KEY = v;
    updateEnvFile('YOUTUBE_API_KEY', v);
  }

  if (proxyEnabled !== undefined) {
    const val = proxyEnabled ? 'true' : 'false';
    updateEnvFile('PROXYLAB_ENABLED', val);
    process.env.PROXYLAB_ENABLED = val;
    PROXYLAB_ENABLED = (val === 'true');
  }
  if (proxyHost     !== undefined) {
    updateEnvFile('PROXYLAB_HOST', proxyHost);
    process.env.PROXYLAB_HOST = proxyHost;
    PROXYLAB_HOST = proxyHost;
  }
  if (proxyPort     !== undefined) {
    updateEnvFile('PROXYLAB_PORT', String(proxyPort));
    process.env.PROXYLAB_PORT = String(proxyPort);
    PROXYLAB_PORT = String(proxyPort);
  }
  if (proxyUsername !== undefined) {
    updateEnvFile('PROXYLAB_USERNAME', proxyUsername);
    process.env.PROXYLAB_USERNAME = proxyUsername;
    PROXYLAB_USERNAME = proxyUsername;
  }
  if (proxyPassword !== undefined) {
    updateEnvFile('PROXYLAB_PASSWORD', proxyPassword);
    process.env.PROXYLAB_PASSWORD = proxyPassword;
    PROXYLAB_PASSWORD = proxyPassword;
  }
  try {
    const { closeBrowser } = require('./platforms/browser');
    closeBrowser();
  } catch {}
  if (telegramNotifyEnabled !== undefined)  updateEnvFile('TELEGRAM_NOTIFY_ENABLED',  telegramNotifyEnabled ? 'true' : 'false');
  if (telegramBotToken !== undefined)       updateEnvFile('TELEGRAM_BOT_TOKEN',       telegramBotToken);
  if (telegramGroupId  !== undefined)       updateEnvFile('TELEGRAM_GROUP_ID',        telegramGroupId);

  botOk('⚙️ Config updated via admin panel');
  res.json({ success: true });
});

// Proxy — test any proxy connection live from dashboard
app.post('/api/proxy/test', requireAuth, async (req, res) => {
  const host     = req.body.host     || process.env.PROXYLAB_HOST;
  const port     = req.body.port     || process.env.PROXYLAB_PORT;
  const username = req.body.username || process.env.PROXYLAB_USERNAME;
  const password = req.body.password || process.env.PROXYLAB_PASSWORD;

  if (!host || !port) {
    return res.status(400).json({ ok: false, message: 'Host and port are required to test proxy' });
  }

  let proxyUrl;
  if (username && password) {
    proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  } else {
    proxyUrl = `http://${host}:${port}`;
  }

  botLog(`🔌 Testing proxy connection to ${host}:${port}...`);

  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    const testRes = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      proxy: false,
      timeout: 9000,
    });
    botOk(`✅ Proxy test successful! Public IP: ${testRes.data.ip}`);
    return res.json({ ok: true, ip: testRes.data.ip, message: `Connected! Proxy IP: ${testRes.data.ip}` });
  } catch (err) {
    let msg = err.message;
    if (err.response?.status === 407 || msg.includes('407')) {
      msg = 'Authentication failed (HTTP 407): Check username & password or IP whitelist.';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      msg = `Cannot reach proxy server (${host}:${port}): Check host and port.`;
    } else if (err.code === 'ETIMEDOUT') {
      msg = 'Connection timed out: Proxy did not respond within 9 seconds.';
    }
    botWarn(`⚠️ Proxy test failed: ${msg}`);
    return res.json({ ok: false, message: msg });
  }
});

// Google / YouTube — test credentials
app.post('/api/google/test', requireAuth, async (req, res) => {
  const { apiKey: customKey, clientId: customClientId } = req.body || {};
  const testApiKey = (customKey !== undefined ? String(customKey).trim() : (process.env.YOUTUBE_API_KEY || ''));
  const testClientId = (customClientId !== undefined ? String(customClientId).trim() : (process.env.GOOGLE_CLIENT_ID || ''));

  let apiKeyStatus = null;
  let oauthStatus = null;

  if (testApiKey) {
    try {
      await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&maxResults=1&key=${testApiKey}`, { timeout: 6000 });
      apiKeyStatus = { ok: true, message: 'YouTube Data API Key is valid and active!' };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      apiKeyStatus = { ok: false, message: `YouTube API Key error: ${msg}` };
    }
  }

  if (testClientId) {
    if (testClientId.includes('.apps.googleusercontent.com')) {
      oauthStatus = { ok: true, message: 'OAuth Client ID format is valid' };
    } else {
      oauthStatus = { ok: false, message: 'OAuth Client ID should end with .apps.googleusercontent.com' };
    }
  }

  if (!testApiKey && !testClientId) {
    return res.status(400).json({ ok: false, message: 'Please enter a YouTube API Key or Client ID to test' });
  }

  const ok = (apiKeyStatus ? apiKeyStatus.ok : true) && (oauthStatus ? oauthStatus.ok : true);
  const message = [apiKeyStatus?.message, oauthStatus?.message].filter(Boolean).join(' | ');

  botLog(`🔍 Google/YouTube credentials tested: ${ok ? 'PASSED' : 'FAILED'}`);
  res.json({ ok, message, apiKeyStatus, oauthStatus });
});

// OpenAI — test API key
app.post('/api/openai/test', requireAuth, async (req, res) => {
  const testKey = (req.body && req.body.openaiApiKey ? String(req.body.openaiApiKey).trim() : process.env.OPENAI_API_KEY);
  if (!testKey) return res.status(400).json({ ok: false, message: 'OpenAI API key is empty' });
  try {
    const testClient = new OpenAI({ apiKey: testKey });
    const models = await testClient.models.list();
    botOk(`🤖 OpenAI test successful (${models.data.length} models accessible)`);
    res.json({ ok: true, message: `Connected! Found ${models.data.length} models.` });
  } catch (err) {
    botWarn(`⚠️ OpenAI test failed: ${err.message}`);
    res.status(400).json({ ok: false, message: err.message });
  }
});

// Telegram — send a test message
app.post('/api/telegram/test', requireAuth, async (req, res) => {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = process.env.TELEGRAM_GROUP_ID;
  if (!token || !groupId) return res.status(400).json({ error: 'Bot token or group ID missing in config' });
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: groupId,
      text:    '✅ <b>YT Bot Admin Panel</b>\n\nTelegram notifications are working! 🎉',
      parse_mode: 'HTML',
    });
    botOk('📨 Telegram test message sent');
    res.json({ success: true });
  } catch (err) {
    botWarn(`⚠️ Telegram test failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Telegram SEO & Group Discovery Endpoints ───────────────
// Search public Telegram groups by keyword and country
app.get('/api/telegram/groups', requireAuth, async (req, res) => {
  const { keyword = '', country = 'ALL', max = 30, minMembers = 1000 } = req.query;
  botLog(`✈️ Searching Telegram groups for "${keyword || 'all'}" (Country: ${country}, Min: ${minMembers})...`);
  try {
    const groups = await telegramSeo.searchGroups(keyword, country, parseInt(max) || 30, parseInt(minMembers) || 0);
    botOk(`✅ Found ${groups.length} vetted Telegram targets`);
    res.json({ ok: true, groups, count: groups.length });
  } catch (err) {
    botError(`❌ Telegram group search failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inspect custom links or usernames
app.post('/api/telegram/inspect', requireAuth, async (req, res) => {
  const { links } = req.body;
  if (!links) return res.status(400).json({ ok: false, error: 'No links or handles provided' });
  botLog(`🔍 Inspecting custom Telegram links...`);
  try {
    const groups = await telegramSeo.inspectLinks(links);
    botOk(`✅ Vetted ${groups.length} custom Telegram links`);
    res.json({ ok: true, groups, count: groups.length });
  } catch (err) {
    botError(`❌ Telegram link inspection failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Post / Blast comment to Telegram target(s)
app.post('/api/telegram/post', requireAuth, async (req, res) => {
  const { target, targets, comment, language = 'Indonesian', backlink = '' } = req.body;
  const targetList = targets && Array.isArray(targets) && targets.length > 0
    ? targets
    : (target ? [target] : []);

  if (targetList.length === 0) {
    return res.status(400).json({ ok: false, error: 'No target Telegram groups specified' });
  }

  const success = [];
  const failed = [];

  botLog(`🚀 Starting Telegram comment blast to ${targetList.length} targets...`);

  for (const t of targetList) {
    try {
      let textToSend = comment;
      if (!textToSend) {
        const promptContext = `Telegram community discussion about: ${t}`;
        textToSend = await generateReply(promptContext, 'metadata', language);
        if (backlink) {
          textToSend += `\n\n🔗 ${backlink}`;
        }
      }
      await platformTelegram.postComment(t, textToSend);
      success.push(t);
      stats.platformStats.telegram = (stats.platformStats.telegram || 0) + 1;
      botOk(`✅ Posted comment to Telegram: ${t}`);
      await delay(1500);
    } catch (err) {
      botWarn(`⚠️ Failed posting to ${t}: ${err.message}`);
      failed.push({ target: t, error: err.message });
    }
  }

  res.json({ ok: true, success, failed });
});

// Telegram Target Groups Management (Add, Edit, Delete)
app.get('/api/telegram/targets', requireAuth, (req, res) => {
  res.json({ ok: true, targets: telegramSeo.loadTargets() });
});

app.post('/api/telegram/targets', requireAuth, (req, res) => {
  const { handle, country = 'GLOBAL', category = 'General', niche = '' } = req.body;
  if (!handle) return res.status(400).json({ ok: false, error: 'Handle is required' });
  try {
    const saved = telegramSeo.saveTarget({ handle, country, category, niche });
    botOk(`✈️ Saved target group: @${saved.handle} (${saved.country} - ${saved.category})`);
    res.json({ ok: true, target: saved, targets: telegramSeo.loadTargets() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/telegram/targets/:handle', requireAuth, (req, res) => {
  const { handle } = req.params;
  const removed = telegramSeo.deleteTarget(handle);
  if (removed) {
    botWarn(`🗑️ Removed target group: @${handle}`);
    res.json({ ok: true, targets: telegramSeo.loadTargets() });
  } else {
    res.status(404).json({ ok: false, error: 'Target not found' });
  }
});


// Accounts
app.get('/api/accounts', requireAuth, (req, res) => {
  const list = users.map(u => ({
    username:       u.username,
    hasToken:       !!u.auth.credentials?.access_token,
    hasRefresh:     !!u.auth.credentials?.refresh_token,
    commentsPosted: accountStats[u.username]?.commentsPosted || 0,
    lastUsed:       accountStats[u.username]?.lastUsed || null,
    status:         accountStats[u.username]?.status || 'idle',
  }));
  res.json(list);
});


app.post('/api/accounts/reload', requireAuth, (req, res) => {
  users = loadUsers();
  botOk(`🔄 Reloaded ${users.length} accounts`);
  res.json({ success: true, count: users.length });
});

app.delete('/api/accounts/:username', requireAuth, (req, res) => {
  const { username } = req.params;
  const tokenPath = `tokens/${username}.json`;
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    users = users.filter(u => u.username !== username);
    delete accountStats[username];
    botWarn(`🗑️ Removed account: ${username}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// Rename account (renames the token file)
app.patch('/api/accounts/:username', requireAuth, (req, res) => {
  const { username }  = req.params;
  const { newName }   = req.body;
  if (!newName || !/^[a-z0-9_\-]+$/i.test(newName)) {
    return res.status(400).json({ error: 'Invalid name — use letters, numbers, underscores only' });
  }
  const oldPath = path.join(__dirname, 'tokens', `${username}.json`);
  const newPath = path.join(__dirname, 'tokens', `${newName}.json`);
  if (!fs.existsSync(oldPath))  return res.status(404).json({ error: 'Account not found' });
  if (fs.existsSync(newPath))   return res.status(400).json({ error: `Name "${newName}" is already taken` });

  fs.renameSync(oldPath, newPath);
  users = loadUsers();
  delete accountStats[username];
  botOk(`✏️ Renamed account: ${username} → ${newName}`);
  res.json({ success: true, username: newName });
});

// Start Google OAuth2 flow — returns auth URL
app.get('/api/auth/google/start', requireAuth, (req, res) => {
  const { username = `user${users.length + 1}` } = req.query;
  const safeName    = username.replace(/[^a-z0-9_\-]/gi, '_');
  // Use the redirect URI already registered in Google Cloud Console
  const callbackUrl = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, callbackUrl);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope:       ['https://www.googleapis.com/auth/youtube.force-ssl'],
    state:       JSON.stringify({ username: safeName }),
    prompt:      'consent',
  });

  botLog(`🔗 OAuth2 URL generated for account: ${safeName} (redirect: ${callbackUrl})`);
  res.json({ url: authUrl, username: safeName, callbackUrl });
});

// OAuth2 callback — Google redirects here after login
// Must match GOOGLE_REDIRECT_URI exactly
app.get('/oauth2callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    botWarn(`⚠️ OAuth2 cancelled: ${error}`);
    return res.send(oauthPage('❌', 'Authentication Cancelled', `Google returned: ${error}`, false));
  }

  try {
    const { username = `user${Date.now()}` } = JSON.parse(state || '{}');
    const callbackUrl  = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, callbackUrl);
    const { tokens }   = await oauth2Client.getToken(code);

    const safeName  = username.replace(/[^a-z0-9_\-]/gi, '_');
    const tokenPath = path.join(__dirname, 'tokens', `${safeName}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

    users = loadUsers();
    botOk(`✅ New account "${safeName}" connected via admin panel`);
    io.emit('accountAdded', { username: safeName });

    res.send(oauthPage('✅', 'Account Connected!', `"${safeName}" has been added. You can close this tab.`, true));
  } catch (err) {
    botError(`❌ OAuth2 callback error: ${err.message}`);
    res.send(oauthPage('❌', 'Authentication Failed', err.message, false));
  }
});

// Also handle /auth/callback as alias (in case user adds it to Google Console later)
app.get('/auth/callback', async (req, res) => {
  req.url = '/oauth2callback';
  res.redirect(307, `/oauth2callback?${new URLSearchParams(req.query).toString()}`);
});

function oauthPage(icon, title, msg, success) {
  const color = success ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html><html><head><title>${title}</title>
    <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0f;color:#e2e8f0;font-family:system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .box{text-align:center;padding:40px;}.icon{font-size:64px;margin-bottom:20px;}
    h2{font-size:24px;margin-bottom:12px;color:${color};}p{color:#94a3b8;font-size:15px;}</style></head>
    <body><div class="box"><div class="icon">${icon}</div><h2>${title}</h2><p>${msg}</p></div></body></html>`;
}

// Post comment (multi-platform with multi-URL and 2-min anti-ban delay)
app.post('/api/post-comment', requireAuth, async (req, res) => {
  const {
    url,
    urls,
    language    = 'Indonesian',
    countryCode = 'ID',
    platforms: selectedPlatforms = ['youtube'],
  } = req.body;

  const targetUrls = Array.isArray(urls) && urls.length > 0
    ? urls.map(u => String(u).trim()).filter(Boolean)
    : (url ? [String(url).trim()] : []);

  if (targetUrls.length === 0) return res.status(400).json({ error: 'At least one video URL is required' });

  botLog(`▶️ Multi-video blast queued: ${targetUrls.length} URL(s) on [${selectedPlatforms.join(', ')}] | Lang: ${language}`);

  // Execute blast in background with coordinated lifecycle
  (async () => {
    try {
      for (let i = 0; i < targetUrls.length; i++) {
        const currentUrl = targetUrls[i];
        const videoId = extractVideoId(currentUrl);

        botLog(`\n======================================================`);
        botLog(`🎬 [Video ${i + 1}/${targetUrls.length}] Processing: ${currentUrl}`);
        botLog(`▶️ Platforms: [${selectedPlatforms.join(', ')}] | Lang: ${language}`);
        botLog(`======================================================`);

        io.emit('postStart', {
          url: currentUrl,
          videoId,
          language,
          countryCode,
          platforms: selectedPlatforms,
          index: i + 1,
          total: targetUrls.length,
        });

        // ── YouTube posting ──
        if (selectedPlatforms.includes('youtube')) {
          if (!videoId) {
            botWarn('⚠️ YouTube selected but URL is not a valid YouTube link or ID — skipping YouTube');
            io.emit('platformDone', { platform: 'youtube', success: [], failed: ['Invalid video URL / ID'] });
          } else {
            try {
              const ytResult = await postComments(videoId, language);
              stats.platformStats.youtube += (ytResult?.success?.length || 0);
              io.emit('platformDone', { platform: 'youtube', ...(ytResult || { success: [], failed: [] }) });
            } catch (ytErr) {
              botError(`❌ YouTube blast failed: ${ytErr.message}`);
              io.emit('platformDone', { platform: 'youtube', success: [], failed: [ytErr.message] });
            }
          }
        }

        // ── Other platforms ──
        const otherPlatforms = selectedPlatforms.filter(p => p !== 'youtube');
        if (otherPlatforms.length > 0) {
          let input = currentUrl;
          let sourceType = 'metadata';
          try {
            if (videoId && users.length > 0) {
              const src = await getCommentsOrMetadata(videoId, users[0].youtube);
              input      = src.type === 'comments'
                ? src.data[Math.floor(Math.random() * src.data.length)]
                : src.data;
              sourceType = src.type;
            }
          } catch {}

          for (const platformId of otherPlatforms) {
            const platform = PLATFORM_REGISTRY[platformId];
            if (!platform) { botWarn(`⚠️ Unknown platform: ${platformId}`); continue; }
            if (!platform.isConfigured()) {
              botWarn(`⚠️ ${platform.name} not configured — skipping`);
              io.emit('platformDone', { platform: platformId, success: [], failed: ['not configured'] });
              continue;
            }
            try {
              botLog(`🔄 Generating ${language} comment for ${platform.icon} ${platform.name}...`);
              const comment = await generateReply(input, sourceType, language);
              botLog(`💬 Comment text: "${comment}"`);
              botLog(`📤 Posting to ${platform.icon} ${platform.name}...`);
              await platform.postComment(currentUrl, comment);
              stats.platformStats[platformId] = (stats.platformStats[platformId] || 0) + 1;
              botOk(`✅ ${platform.icon} ${platform.name} posted: "${comment}"`);
              io.emit('platformDone', { platform: platformId, success: [platformId], comment, failed: [] });
            } catch (err) {
              botError(`❌ ${platform.icon} ${platform.name} failed: ${err.message}`);
              io.emit('platformDone', { platform: platformId, success: [], failed: [err.message] });
            }
          }
        }

        // ── Anti-ban delay: wait 2 minutes (120s) before posting to next video ──
        if (i < targetUrls.length - 1) {
          botLog(`⏳ [Anti-Ban Safety] Pausing 2 minutes (120s) before video ${i + 2}/${targetUrls.length}...`);
          for (let sec = 120; sec > 0; sec -= 30) {
            botLog(`⏳ Next video in ${sec}s...`);
            await new Promise(r => setTimeout(r, Math.min(sec, 30) * 1000));
          }
        }
      }
    } catch (globalErr) {
      botError(`❌ Unhandled error during comment blast: ${globalErr.message}`);
    } finally {
      botOk(`🏁 Completed blast queue of ${targetUrls.length} video(s)!`);
      io.emit('postDone', { platforms: selectedPlatforms, total: targetUrls.length });
    }
  })();

  res.json({
    success: true,
    message: `Started blast on ${targetUrls.length} video(s) with 2-minute safety delays. Watch live terminal.`
  });
});

// Trending videos (multi-platform)
app.get('/api/trending', requireAuth, async (req, res) => {
  const { region = 'ID', max = 20, platform = 'youtube' } = req.query;
  const country = COUNTRIES.find(c => c.code === region);
  botLog(`🔥 Fetching ${platform} trending for ${country?.name || region}...`);

  try {
    let videos;
    if (platform === 'youtube') {
      videos = await getTrendingVideos(region, parseInt(max));
    } else {
      const p = PLATFORM_REGISTRY[platform];
      if (!p || !p.getTrending) {
        return res.status(400).json({ error: `${platform} does not support trending` });
      }
      if (!p.isConfigured()) {
        return res.status(400).json({ error: `${p.name} is not configured` });
      }
      videos = await p.getTrending(region, parseInt(max));
    }
    botOk(`✅ Fetched ${videos.length} ${platform} trending items for ${region}`);
    res.json({ videos, region, country, platform });
  } catch (err) {
    botError(`❌ Trending fetch error (${platform}): ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Platform registry
app.get('/api/platforms', requireAuth, (req, res) => {
  const tiktokCookieFile = path.join(__dirname, 'tokens', 'tiktok_cookies.json');
  const tiktokStatus = platformTikTok.getCookieStatus ? platformTikTok.getCookieStatus() : { hasCookies: fs.existsSync(tiktokCookieFile) };

  const fbCookieFile = path.join(__dirname, 'tokens', 'facebook_cookies.json');
  const fbStatus = platformFacebook.getCookieStatus ? platformFacebook.getCookieStatus() : { hasCookies: fs.existsSync(fbCookieFile) };

  const list = Object.values(PLATFORM_REGISTRY).map(p => ({
    id:               p.id,
    name:             p.name,
    icon:             p.icon,
    color:            p.color,
    accent:           p.accent,
    configured:       p.isConfigured(),
    supportsTrending: p.supportsTrending || false,
    postsThisSession: stats.platformStats[p.id] || 0,
    hasCookies:       p.id === 'tiktok' ? tiktokStatus.hasCookies : (p.id === 'facebook' ? fbStatus.hasCookies : false),
    cookieStatus:     p.id === 'tiktok' ? tiktokStatus : (p.id === 'facebook' ? fbStatus : null),
    credentialFields: (p.credentialFields || []).map(f => ({
      ...f,
      value:    f.type === 'password' ? '' : (process.env[f.key] || ''),
      hasValue: !!process.env[f.key],
    })),
  }));
  res.json(list);
});

// Test a platform connection
app.post('/api/platforms/:id/test', requireAuth, async (req, res) => {
  const { id } = req.params;
  const platform = PLATFORM_REGISTRY[id];
  if (!platform) return res.status(404).json({ error: 'Platform not found' });
  botLog(`🔌 Testing ${platform.icon} ${platform.name} connection...`);
  try {
    const result = await platform.testConnection();
    if (result.ok) botOk(`✅ ${platform.name}: ${result.message}`);
    else           botWarn(`⚠️ ${platform.name}: ${result.message}`);
    res.json(result);
  } catch (err) {
    botError(`❌ ${platform.name} test error: ${err.message}`);
    res.json({ ok: false, message: err.message });
  }
});

// Save platform credentials (writes to .env and hot-reloads)
app.post('/api/platforms/:id/credentials', requireAuth, async (req, res) => {
  const { id }     = req.params;
  const platform   = PLATFORM_REGISTRY[id];
  if (!platform) return res.status(404).json({ error: 'Platform not found' });

  const updates = req.body; // { TIKTOK_USERNAME: 'x', TIKTOK_PASSWORD: 'y' }
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, message: 'No credentials provided' });
  }

  // Only allow keys that belong to this platform
  const allowedKeys = (platform.credentialFields || []).map(f => f.key);
  const filtered    = {};
  for (const key of allowedKeys) {
    if (updates[key] !== undefined && updates[key] !== '') filtered[key] = updates[key];
  }

  if (Object.keys(filtered).length === 0) {
    return res.status(400).json({ ok: false, message: 'No valid credential fields provided' });
  }

  try {
    botLog(`💾 Saving credentials for ${platform.icon} ${platform.name}...`);
    updateEnvFile(filtered);
    botOk(`✅ Credentials saved for ${platform.name} — testing connection...`);

    // Test the connection with the new credentials
    const result = await platform.testConnection();
    if (result.ok) {
      botOk(`✅ ${platform.name} login successful!`);
    } else {
      botWarn(`⚠️ ${platform.name}: ${result.message}`);
    }

    res.json({
      ...result,
      configured: platform.isConfigured(),
    });
  } catch (err) {
    botError(`❌ ${platform.name} credential save error: ${err.message}`);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// TikTok Cookie & Multi-Account Endpoints
app.get('/api/tiktok/cookies', requireAuth, (req, res) => {
  const status = platformTikTok.getCookieStatus ? platformTikTok.getCookieStatus() : { hasCookies: false };
  res.json({ ok: true, status });
});

app.post('/api/tiktok/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ ok: false, error: 'No cookies provided' });
  try {
    const status = platformTikTok.saveCookies(cookies);
    // Also save/update in accounts directory as default account
    if (platformTikTok.saveAccount) {
      try { platformTikTok.saveAccount('Account 1 (@renepacho1)', cookies); } catch {}
    }
    botOk(`🍪 TikTok cookies updated via admin panel (${status.cookieCount} cookies, valid: ${status.valid})`);
    res.json({ ok: true, status });
  } catch (err) {
    botWarn(`⚠️ Failed to save TikTok cookies: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// TikTok Multi-Account Endpoints
app.get('/api/tiktok/accounts', requireAuth, (req, res) => {
  try {
    const accounts = platformTikTok.getAccountsList ? platformTikTok.getAccountsList() : [];
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tiktok/accounts', requireAuth, (req, res) => {
  const { name, cookies } = req.body;
  if (!cookies) return res.status(400).json({ ok: false, error: 'No cookies provided' });
  try {
    const account = platformTikTok.saveAccount(name, cookies);
    botOk(`✅ Added TikTok account: "${account.name}" (${account.cookieCount} cookies)`);
    res.json({ ok: true, account, accounts: platformTikTok.getAccountsList() });
  } catch (err) {
    botWarn(`⚠️ Failed to add TikTok account: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/tiktok/accounts/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  try {
    const deleted = platformTikTok.deleteAccount(id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Account not found' });
    botLog(`🗑️ Removed TikTok account ID: ${id}`);
    res.json({ ok: true, accounts: platformTikTok.getAccountsList() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Facebook Cookie & Multi-Account Endpoints
app.get('/api/facebook/cookies', requireAuth, (req, res) => {
  const status = platformFacebook.getCookieStatus ? platformFacebook.getCookieStatus() : { hasCookies: false };
  res.json({ ok: true, status });
});

app.post('/api/facebook/cookies', requireAuth, (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ ok: false, error: 'No cookies provided' });
  try {
    const status = platformFacebook.saveCookies(cookies);
    botOk(`🍪 Facebook cookies updated via admin panel (${status.cookieCount} cookies, valid: ${status.valid})`);
    res.json({ ok: true, status });
  } catch (err) {
    botWarn(`⚠️ Failed to save Facebook cookies: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/facebook/accounts', requireAuth, (req, res) => {
  try {
    const accounts = platformFacebook.getAccountsList ? platformFacebook.getAccountsList() : [];
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/facebook/accounts', requireAuth, (req, res) => {
  const { name, cookies } = req.body;
  if (!cookies) return res.status(400).json({ ok: false, error: 'No cookies provided' });
  try {
    const account = platformFacebook.saveAccount(name, cookies);
    botOk(`✅ Added Facebook account: "${account.name}" (${account.cookieCount} cookies)`);
    res.json({ ok: true, account, accounts: platformFacebook.getAccountsList() });
  } catch (err) {
    botWarn(`⚠️ Failed to add Facebook account: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/facebook/accounts/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  try {
    const deleted = platformFacebook.deleteAccount(id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Account not found' });
    botLog(`🗑️ Removed Facebook account ID: ${id}`);
    res.json({ ok: true, accounts: platformFacebook.getAccountsList() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Keywords
app.get('/api/keywords', requireAuth, (req, res) => {
  res.json(keywords);
});

app.post('/api/keywords', requireAuth, (req, res) => {
  const { keywords: kw } = req.body;
  if (!Array.isArray(kw) || kw.length === 0) {
    return res.status(400).json({ error: 'keywords must be a non-empty array' });
  }
  keywords = kw.map(k => k.trim().toUpperCase()).filter(Boolean);
  saveKeywords(keywords);
  botOk(`✏️ Keywords updated & saved: ${keywords.join(', ')}`);
  res.json({ success: true, keywords });
});


// Logs
app.get('/api/logs', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(logs.slice(-limit));
});

// ─── Socket.io ───────────────────────────────────────────────
io.on('connection', (socket) => {
  botLog(`🔌 Admin client connected (authenticated)`);
  // Send recent logs on connect
  socket.emit('initLogs', logs.slice(-100));
  socket.on('disconnect', () => {
    botLog(`🔌 Admin client disconnected`);
  });
});

// ─── 404 Handler ─────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
  }
  // For non-API routes, serve the SPA index
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────
server.listen(PORT, () => {
  botOk(`🚀 Admin panel running at http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === 'admin123') {
    botWarn(`⚠️  WARNING: Admin password is still the default "admin123" — change it in .env!`);
  }
  botLog(`🔐 Admin password is set`);
  botLog(`📋 ${users.length} account(s) loaded`);
  botLog(`🌍 ${COUNTRIES.length} countries supported`);
});
