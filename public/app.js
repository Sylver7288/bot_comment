/* ============================================================
   YT Bot Admin Panel — Frontend Logic
   ============================================================ */

// ─── State ──────────────────────────────────────────────────
let adminToken      = localStorage.getItem('adminToken') || null;
let countries       = [];
let allPlatforms    = [];
let selectedPlatforms = new Set(JSON.parse(localStorage.getItem('selectedPlatforms') || '["youtube"]'));
let currentTab      = 'dashboard';
let isPosting       = false;
let defaultCountry  = localStorage.getItem('defaultCountry') || 'ID';
let socket          = null;
let statsInterval   = null;

// ─── Global Toggle Helpers (called via HTML onclick) ─────────
function toggleSafeMode() {
  const cb  = document.getElementById('safeModeToggle');
  const btn = document.getElementById('safeModeSwitchLabel');
  if (!cb || !btn) return;
  cb.checked = !cb.checked;
  btn.textContent      = cb.checked ? 'Enabled' : 'Disabled';
  btn.style.background = cb.checked ? 'var(--green)' : 'var(--bg-input)';
  btn.style.color      = cb.checked ? '#fff' : 'var(--text-secondary)';
  btn.style.border     = cb.checked ? 'none' : '1px solid var(--border)';
}
window.toggleSafeMode = toggleSafeMode;


// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme immediately (before anything renders)
  applyTheme(localStorage.getItem('theme') || 'dark');

  // If already have a token, try to restore session
  if (adminToken) {
    fetchCountries().then(() => {
      verifyToken().then(valid => {
        if (valid) showApp();
        else       showLogin();
      });
    });
  } else {
    fetchCountries().then(showLogin);
  }

  // Login form
  document.getElementById('loginForm').addEventListener('submit', handleLogin);

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Clock
  updateClock();
  setInterval(updateClock, 1000);
});

// ─── Theme ───────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const icon  = document.getElementById('themeIcon');
  const btn   = document.getElementById('themeToggle');
  if (icon) icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  if (btn)  btn.title        = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
}


// ─── Auth ────────────────────────────────────────────────────
async function fetchCountries() {
  try {
    const res = await fetch('/api/countries');
    countries = await res.json();
  } catch { countries = []; }
}

async function verifyToken() {
  try {
    const res = await api('/api/status');
    return res.ok;
  } catch { return false; }
}

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('loginPassword').value;
  const btn      = document.getElementById('loginBtn');
  const errEl    = document.getElementById('loginError');

  btn.classList.add('btn-loading');
  btn.disabled = true;
  errEl.classList.add('hidden');

  try {
    const res  = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (data.success) {
      adminToken = data.token;
      localStorage.setItem('adminToken', adminToken);
      showApp();
    } else {
      errEl.classList.remove('hidden');
    }
  } catch {
    errEl.classList.remove('hidden');
    errEl.textContent = '❌ Could not reach server.';
  } finally {
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

function handleLogout() {
  adminToken = null;
  localStorage.removeItem('adminToken');
  if (socket) socket.disconnect();
  if (statsInterval) clearInterval(statsInterval);
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
}

// ─── Show App ────────────────────────────────────────────────
function showApp() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  populateAllSelectors();
  loadPlatforms();          // ← load platform toggles
  initSocket();
  setupNavigation();
  setupPostCommentTab();
  setupTrendingTab();
  setupTelegramSeoTab();
  setupAccountsTab();
  setupSettingsTab();
  switchTab('dashboard');
  loadStats();
  statsInterval = setInterval(loadStats, 10000);
}

function showLogin() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ─── Socket.io ───────────────────────────────────────────────
function initSocket() {
  socket = io({
    query: { token: adminToken || '' },
  });

  socket.on('connect', () => {
    setStatus(true);
    toast('🟢 Connected to server', 'success');
  });

  socket.on('disconnect', () => {
    setStatus(false);
    toast('🔴 Disconnected from server', 'error');
  });

  socket.on('initLogs', (entries) => {
    entries.forEach(e => appendLog(e, 'liveTerminal'));
    entries.slice(-5).forEach(e => appendLog(e, 'miniLog'));
  });

  socket.on('log', (entry) => {
    appendLog(entry, 'liveTerminal');
    appendLog(entry, 'miniLog');
  });

  socket.on('postStart', ({ url, videoId, language, countryCode, platforms, index, total }) => {
    document.getElementById('postCommentBtn').disabled = true;
    const progress = total > 1 ? ` (${index || 1}/${total})` : '';
    document.getElementById('postBtnText').textContent  = `⏳ Posting${progress}...`;
    isPosting = true;
  });

  socket.on('platformDone', ({ platform, success, failed }) => {
    const p = allPlatforms.find(x => x.id === platform);
    const name = p ? `${p.icon} ${p.name}` : platform;
    if (failed.length === 0) toast(`✅ ${name}: posted!`, 'success');
    else toast(`⚠️ ${name}: ${failed[0]}`, 'warn');
  });

  socket.on('postDone', ({ platforms }) => {
    isPosting = false;
    document.getElementById('postCommentBtn').disabled = false;
    document.getElementById('postBtnText').textContent  = '🚀 Blast Comments';
    loadStats();
  });

  socket.on('accountStatus', ({ username, status }) => {
    // Update inline badge in accounts table
    const row = document.querySelector(`tr[data-user="${username}"]`);
    if (row) {
      const statusCell = row.querySelector('.account-status');
      if (statusCell) statusCell.innerHTML = accountStatusBadge(status);
    }
  });

  // Fired when a new account is authenticated via OAuth callback
  socket.on('accountAdded', ({ username }) => {
    loadAccounts();
    loadStats();
    toast(`✅ "${username}" connected successfully!`, 'success', 5000);
    // Advance modal to success step if open
    const step2 = document.getElementById('authStep2');
    const step3 = document.getElementById('authStep3');
    if (step2 && !step2.classList.contains('hidden')) {
      const nameEl = document.getElementById('authSuccessName');
      if (nameEl) nameEl.textContent = username;
      step2.classList.add('hidden');
      step3?.classList.remove('hidden');
    }
  });
}

function setStatus(online) {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  dot.className   = `status-dot ${online ? 'online' : 'offline'}`;
  label.textContent = online ? 'Online' : 'Offline';
}

// ─── Navigation ──────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(item.dataset.tab);
    });
  });
}

function switchTab(tab) {
  currentTab = tab;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.getElementById(`nav-${tab}`);
  if (navEl) navEl.classList.add('active');

  // Update panels
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.classList.add('active');

  // Page title
  const titles = {
    dashboard:      'Dashboard',
    post:           'Post Comment',
    trending:       'Trending Videos',
    'telegram-seo': 'Telegram SEO & Group Finder',
    accounts:       'Accounts',
    settings:       'Settings',
  };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;

  // Load data for tab
  if (tab === 'accounts')     { loadAccounts(); loadTikTokAccounts(); loadFacebookAccounts(); loadInstagramAccounts(); loadTwitterAccounts(); loadRedditAccounts(); }
  if (tab === 'settings')     loadSettings();
  if (tab === 'dashboard')    loadStats();
  if (tab === 'telegram-seo') loadTelegramGroups();
}

// ─── Country Selectors ───────────────────────────────────────
function populateAllSelectors() {
  const ids = ['globalCountrySelect', 'postCountrySelect', 'trendingCountrySelect', 'defaultCountrySelect'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = countries.map(c =>
      `<option value="${c.code}" data-language="${c.language}" ${c.code === defaultCountry ? 'selected' : ''}>${c.flag} ${c.name}</option>`
    ).join('');
  });

  // Populate Telegram SEO Country dropdowns
  const tgSearchSel = document.getElementById('tgSearchCountry');
  if (tgSearchSel) {
    const currentVal = tgSearchSel.value || 'ALL';
    tgSearchSel.innerHTML = `
      <option value="ALL" ${currentVal === 'ALL' ? 'selected' : ''}>🌐 All Countries</option>
      <option value="GLOBAL" ${currentVal === 'GLOBAL' ? 'selected' : ''}>🌍 Global / English</option>
      ${countries.map(c => `<option value="${c.code}" ${c.code === currentVal ? 'selected' : ''}>${c.flag} ${c.name}</option>`).join('')}
    `;
  }

  const tgTargetSel = document.getElementById('selectTgTargetCountry');
  if (tgTargetSel) {
    tgTargetSel.innerHTML = `
      <option value="GLOBAL">🌍 Global / English</option>
      ${countries.map(c => `<option value="${c.code}">${c.flag} ${c.name} (${c.code})</option>`).join('')}
    `;
  }

  // Sync global selector → others
  document.getElementById('globalCountrySelect').addEventListener('change', (e) => {
    const code = e.target.value;
    syncCountrySelectors(code);
  });

  // When post selector changes, update language hint
  document.getElementById('postCountrySelect').addEventListener('change', updateLanguageHint);
  updateLanguageHint();
}

function syncCountrySelectors(code) {
  ['postCountrySelect', 'trendingCountrySelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = code;
  });
  updateLanguageHint();
}

function getSelectedCountry(selectId) {
  const sel  = document.getElementById(selectId);
  const code = sel?.value;
  return countries.find(c => c.code === code) || countries[0];
}

function updateLanguageHint() {
  const country = getSelectedCountry('postCountrySelect');
  const hint = document.getElementById('postLanguageHint');
  if (hint) {
    hint.innerHTML = `AI will generate comments in <strong>${country?.language || 'the selected language'}</strong> (${country?.flag || ''} ${country?.name || ''})`;
  }
}

// ─── Dashboard ───────────────────────────────────────────────
async function loadStats() {
  try {
    const res  = await api('/api/status');
    const data = await res.json();

    setText('statAccounts', data.accountsLoaded);
    setText('statComments', data.commentsPosted);
    setText('statUptime',   data.uptime);
    setText('statProxy',    data.proxyEnabled ? '🛡️ Active' : '⚠️ Off');

    // Badge for post tab
    const badge = document.getElementById('postAccountCount');
    if (badge) badge.textContent = `${data.accountsLoaded} account${data.accountsLoaded !== 1 ? 's' : ''}`;

    // Recent activity
    renderActivity(data.commentHistory || []);
  } catch (err) {
    console.warn('Stats load failed:', err);
  }
}

function renderActivity(history) {
  const el = document.getElementById('recentActivity');
  if (!el) return;
  if (history.length === 0) {
    el.innerHTML = '<div class="empty-state">No activity yet</div>';
    return;
  }
  el.innerHTML = history.slice(0, 8).map(h => {
    const d = new Date(h.time);
    const timeStr = d.toLocaleTimeString();
    return `
      <div class="activity-item">
        <span>📺 <code>${h.videoId}</code></span>
        <span class="badge badge-green">${h.success} ok</span>
        ${h.failed > 0 ? `<span class="badge badge-red">${h.failed} fail</span>` : ''}
        <span class="badge badge-cyan">${h.language || '?'}</span>
        <span class="activity-meta">${timeStr}</span>
      </div>`;
  }).join('');
}

document.getElementById('refreshStats')?.addEventListener('click', loadStats);

// ─── Post Comment Tab ────────────────────────────────────────
function setupPostCommentTab() {
  // Paste button
  document.getElementById('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      document.getElementById('videoUrlInput').value = text;
    } catch {
      toast('Clipboard access denied', 'warn');
    }
  });

  // Post button
  document.getElementById('postCommentBtn').addEventListener('click', handlePostComment);

  // Clear log button
  document.getElementById('clearLogBtn').addEventListener('click', () => {
    document.getElementById('liveTerminal').innerHTML =
      '<div class="terminal-line muted"><span class="msg">$ Terminal cleared</span></div>';
  });

  // Load keywords
  loadKeywordBadges();
}

async function handlePostComment() {
  if (isPosting) return;

  const rawInput = document.getElementById('videoUrlInput').value.trim();
  const urls = rawInput.split('\n').map(u => u.trim()).filter(Boolean);
  const country = getSelectedCountry('postCountrySelect');
  const platforms = Array.from(selectedPlatforms);

  if (urls.length === 0) { toast('Please enter at least one video URL', 'warn'); return; }
  if (platforms.length === 0) { toast('Select at least one platform', 'warn'); return; }

  try {
    const res  = await api('/api/post-comment', 'POST', {
      urls,
      url:         urls[0],
      countryCode: country.code,
      language:    country.language,
      platforms,
    });
    const data = await res.json();
    if (!res.ok) toast(`❌ ${data.error || 'Failed'}`, 'error');
    else {
      const msg = urls.length > 1
        ? `🚀 Started bulk blast on ${urls.length} videos (2 min delay) — watch terminal`
        : `🚀 Started on [${platforms.join(', ')}] — watch terminal`;
      toast(msg, 'info');
    }
    if (currentTab !== 'post') switchTab('post');
  } catch (err) {
    toast(`❌ Network error: ${err.message}`, 'error');
  }
}

async function loadKeywordBadges() {
  try {
    const res  = await api('/api/keywords');
    const kw   = await res.json();
    const el   = document.getElementById('keywordBadges');
    if (el) {
      el.innerHTML = kw.map(k => `<span class="keyword-badge">#${k}</span>`).join('');
    }
  } catch {}
}

// ─── Trending Tab ─────────────────────────────────────────────
let currentTrendingVideos = [];
let currentTrendingPlatform = 'youtube';
let currentTrendingCountry = null;

function sendAllTrendingToPostComment() {
  if (!currentTrendingVideos || currentTrendingVideos.length === 0) {
    toast('No trending videos loaded yet. Click "Fetch Trending" first.', 'warn');
    return;
  }

  const urls = currentTrendingVideos.map(v => v.url).filter(Boolean);
  if (urls.length === 0) {
    toast('No valid video URLs found.', 'error');
    return;
  }

  const platform = currentTrendingPlatform || 'youtube';
  const country = currentTrendingCountry;

  if (country) {
    const postCountryEl = document.getElementById('postCountrySelect');
    if (postCountryEl) postCountryEl.value = country.code;
    updateLanguageHint();
  }

  const input = document.getElementById('videoUrlInput');
  if (input) {
    input.value = urls.join('\n');
  }

  selectedPlatforms.clear();
  selectedPlatforms.add(platform);
  renderPlatformToggles();

  switchTab('post');
  toast(`🚀 Imported ${urls.length} ${platform} video links! Click "Blast Comments" to begin.`, 'success');
}

async function importTrendingToPostForm() {
  const btn = document.getElementById('btnImportTrending');
  if (btn) btn.textContent = '⏳ Loading...';

  try {
    const platform = selectedPlatforms.size > 0 ? Array.from(selectedPlatforms)[0] : 'facebook';
    const countryEl = document.getElementById('postCountrySelect');
    const countryCode = countryEl ? countryEl.value : 'IN';

    const res = await api(`/api/trending?region=${countryCode}&max=10&platform=${platform}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch trending');

    const videos = data.videos || [];
    const urls = videos.map(v => v.url).filter(Boolean);

    if (urls.length === 0) {
      toast('No trending video links found for this platform/region', 'warn');
      return;
    }

    const input = document.getElementById('videoUrlInput');
    if (input) {
      input.value = urls.join('\n');
    }

    toast(`🔥 Auto-filled ${urls.length} ${platform} trending video links! Ready to blast.`, 'success');
  } catch (err) {
    toast(`❌ Failed to load trending: ${err.message}`, 'error');
  } finally {
    if (btn) btn.textContent = '⚡ Auto-Fill Trending Links';
  }
}

function setupTrendingTab() {
  document.getElementById('fetchTrendingBtn').addEventListener('click', fetchTrending);
}

async function fetchTrending() {
  const country  = getSelectedCountry('trendingCountrySelect');
  const max      = document.getElementById('trendingMaxResults').value;
  const platform = document.getElementById('trendingPlatformSelect')?.value || 'youtube';
  const grid     = document.getElementById('trendingGrid');
  const status   = document.getElementById('trendingStatus');
  const btn      = document.getElementById('fetchTrendingBtn');

  btn.disabled = true;
  btn.textContent = '⏳ Loading...';
  const platformName = platform === 'tiktok' ? 'TikTok' : platform === 'reddit' ? 'Reddit' : platform === 'twitter' ? 'Twitter / X' : platform === 'instagram' ? 'Instagram' : platform === 'facebook' ? 'Facebook' : 'YouTube';
  status.textContent = `🔍 Fetching ${platformName} trending for ${country.flag} ${country.name}...`;
  status.className = 'section-status loading';
  status.classList.remove('hidden');
  grid.innerHTML = '<div class="spinner" style="margin:40px auto;grid-column:1/-1;"></div>';

  try {
    const res  = await api(`/api/trending?region=${country.code}&max=${max}&platform=${platform}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to fetch');

    const { videos } = data;
    currentTrendingVideos = videos;
    currentTrendingPlatform = platform;
    currentTrendingCountry = country;

    const sendAllBtn = document.getElementById('sendAllTrendingBtn');
    const sendCount = document.getElementById('trendingCountNum');
    if (sendAllBtn && sendCount) {
      if (videos.length > 0) {
        sendCount.textContent = videos.length;
        sendAllBtn.style.display = 'inline-flex';
      } else {
        sendAllBtn.style.display = 'none';
      }
    }

    status.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;width:100%;">
        <span>✅ ${videos.length} ${platformName} trending items in ${country.flag} ${country.name}</span>
        ${videos.length > 0 ? `
          <button class="btn btn-success btn-sm" onclick="sendAllTrendingToPostComment()" style="font-weight:600;">
            🚀 Blast All ${videos.length} Links to Post Comment
          </button>
        ` : ''}
      </div>`;
    status.className = 'section-status';

    if (videos.length === 0) {
      grid.innerHTML = '<div class="empty-state-large"><span class="empty-icon">📭</span><p>No videos found for this region.</p></div>';
    } else {
      grid.innerHTML = videos.map((v, i) => videoCard(v, i + 1, country, platform)).join('');
      // Attach post buttons
      grid.querySelectorAll('.video-post-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const url      = btn.dataset.url;
          const language = country.language;
          // Fill post comment form and switch tab
          document.getElementById('videoUrlInput').value = url;
          document.getElementById('postCountrySelect').value = country.code;
          updateLanguageHint();
          // Auto-select the source platform
          selectedPlatforms.clear();
          selectedPlatforms.add(platform);
          renderPlatformToggles();
          switchTab('post');
          toast(`Loaded ${platformName} video — Click "Blast Comments" to post`, 'info');
        });
      });
    }
  } catch (err) {
    status.textContent = `❌ Error: ${err.message}`;
    status.className = 'section-status error';
    grid.innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '🔥 Fetch Trending';
  }
}

function videoCard(v, rank, country, platform = 'youtube') {
  const thumb = v.thumbnail || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
  const platformIcon = platform === 'tiktok' ? '🎵' : platform === 'reddit' ? '🟠' : platform === 'twitter' ? '🐦' : platform === 'instagram' ? '📸' : platform === 'facebook' ? '📘' : '🎥';
  return `
    <div class="video-card">
      <img class="video-thumb" src="${thumb}" alt="${escHtml(v.title)}" loading="lazy" onerror="this.src='https://i.ytimg.com/vi/${v.id}/mqdefault.jpg'" />
      <div class="video-body">
        <div class="video-rank">#${rank} ${platformIcon} • ${country.flag} ${country.name}</div>
        <div class="video-title" title="${escHtml(v.title)}">${escHtml(v.title)}</div>
        <div class="video-meta">📺 ${escHtml(v.channel)} &nbsp;·&nbsp; 👁️ ${v.views || 'Viral'}</div>
      </div>
      <div class="video-footer">
        <button class="btn btn-primary btn-sm btn-full video-post-btn"
          data-url="${v.url}"
          data-videoid="${v.id}">
          💬 Post Comments (${country.language})
        </button>
      </div>
    </div>`;
}

// ─── Accounts Tab ────────────────────────────────────────────
function setupAccountsTab() {
  loadTikTokAccounts();
  loadFacebookAccounts();
  loadInstagramAccounts();
  loadTwitterAccounts();
  loadRedditAccounts();
  document.getElementById('reloadAccountsBtn').addEventListener('click', async () => {
    const btn = document.getElementById('reloadAccountsBtn');
    btn.disabled = true;
    btn.textContent = '↻ Reloading...';
    try {
      const res  = await api('/api/accounts/reload', 'POST');
      const data = await res.json();
      toast(`✅ Reloaded ${data.count} accounts`, 'success');
      loadAccounts();
      loadStats();
    } catch {
      toast('Failed to reload accounts', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Reload Accounts';
    }
  });
}

async function loadAccounts() {
  const tbody = document.getElementById('accountsBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty-cell"><div class="spinner"></div></td></tr>';

  try {
    const res      = await api('/api/accounts');
    const accounts = await res.json();

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No accounts loaded. Run get_token.js to add accounts.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr data-user="${a.username}">
        <td><strong>${escHtml(a.username)}</strong></td>
        <td>${a.hasToken   ? '<span class="badge badge-green">✅ Valid</span>'   : '<span class="badge badge-red">❌ Missing</span>'}</td>
        <td>${a.hasRefresh ? '<span class="badge badge-green">✅ Valid</span>'   : '<span class="badge badge-red">❌ Missing</span>'}</td>
        <td><strong>${a.commentsPosted}</strong></td>
        <td>${a.lastUsed ? new Date(a.lastUsed).toLocaleString() : '<span class="text-muted">Never</span>'}</td>
        <td class="account-status">${accountStatusBadge(a.status)}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="openRenameModal('${a.username}')">✏️ Rename</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAccount('${a.username}')">🗑️ Remove</button>
        </td>
      </tr>`).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Failed to load accounts.</td></tr>';
  }
}

function accountStatusBadge(status) {
  const map = {
    idle:    '<span class="badge badge-cyan">💤 Idle</span>',
    posting: '<span class="badge badge-yellow">⏳ Posting</span>',
    error:   '<span class="badge badge-red">❌ Error</span>',
  };
  return map[status] || '<span class="badge badge-cyan">💤 Idle</span>';
}

async function deleteAccount(username) {
  if (!confirm(`Remove account "${username}"? This will delete its token file.`)) return;
  try {
    const res = await api(`/api/accounts/${username}`, 'DELETE');
    if (res.ok) {
      toast(`🗑️ Removed ${username}`, 'warn');
      loadAccounts();
    } else {
      toast('Failed to remove account', 'error');
    }
  } catch {
    toast('Network error', 'error');
  }
}

// ─── Rename Account Modal ───────────────────────────────────────
function openRenameModal(username) {
  document.getElementById('renameAccountOldName').value = username;
  document.getElementById('renameAccountInput').value   = username;
  document.getElementById('renameAccountModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('renameAccountInput').focus(), 100);
}

async function confirmRenameAccount() {
  const oldName = document.getElementById('renameAccountOldName').value;
  const newName = document.getElementById('renameAccountInput').value.trim();
  if (!newName || newName === oldName) { closeModal('renameAccountModal'); return; }

  try {
    const res  = await api(`/api/accounts/${oldName}`, 'PATCH', { newName });
    const data = await res.json();
    if (res.ok) {
      toast(`✏️ Renamed "${oldName}" to "${newName}"`, 'success');
      closeModal('renameAccountModal');
      loadAccounts();
    } else {
      toast(`❌ ${data.error}`, 'error');
    }
  } catch {
    toast('Network error', 'error');
  }
}

// ─── Add Account (OAuth2) Modal ────────────────────────────────
function openAddAccountModal() {
  // Reset to step 1
  document.getElementById('authStep1').classList.remove('hidden');
  document.getElementById('authStep2').classList.add('hidden');
  document.getElementById('authStep3').classList.add('hidden');
  document.getElementById('newAccountName').value = `user${Date.now().toString().slice(-3)}`;
  document.getElementById('addAccountModal').classList.remove('hidden');
}

async function generateAuthLink() {
  const username = document.getElementById('newAccountName').value.trim();
  if (!username) { toast('Enter an account name first', 'warn'); return; }

  const btn = document.getElementById('genLinkBtnText');
  btn.textContent = '⏳ Generating...';

  try {
    const res  = await api(`/api/auth/google/start?username=${encodeURIComponent(username)}`);
    const data = await res.json();

    document.getElementById('authLinkAnchor').href = data.url;
    document.getElementById('authStep1').classList.add('hidden');
    document.getElementById('authStep2').classList.remove('hidden');
    document.getElementById('authWaiting').style.display = 'flex';
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  } finally {
    btn.textContent = '✨ Generate Login Link';
  }
}

// Modal helpers
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// Close modal on backdrop click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ─── Settings Tab ──────────────────────────────────────────────────
// Expose for inline onclick handlers
window.deleteAccount          = deleteAccount;
window.openRenameModal        = openRenameModal;
window.confirmRenameAccount   = confirmRenameAccount;
window.openAddAccountModal    = openAddAccountModal;
window.generateAuthLink       = generateAuthLink;
window.closeModal             = closeModal;
window.switchTab              = switchTab;
window.testPlatform           = testPlatform;
window.savePlatformCredentials = savePlatformCredentials;

function setupSettingsTab() {
  document.getElementById('saveKeywordsBtn')?.addEventListener('click', saveKeywords);
  document.getElementById('saveDefaultCountryBtn')?.addEventListener('click', saveDefaultCountry);
  const refreshBtn = document.getElementById('refreshPlatformsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => { loadPlatforms(); loadPlatformStatuses(); });

  // Proxy enable toggle switch
  const toggle = document.getElementById('proxyEnabledToggle');
  const switchLabel = document.getElementById('proxySwitchLabel');
  if (toggle && switchLabel) {
    toggle.addEventListener('change', () => {
      switchLabel.textContent = toggle.checked ? 'Enabled' : 'Disabled';
      switchLabel.style.background = toggle.checked ? 'var(--green)' : '';
      switchLabel.style.color = toggle.checked ? '#fff' : '';
    });
  }

  // Save proxy button
  const saveProxy = document.getElementById('saveProxyBtn');
  if (saveProxy) saveProxy.addEventListener('click', saveProxyConfig);
  document.getElementById('testProxyBtn')?.addEventListener('click', testProxyConfig);

  // Telegram toggle
  const tgToggle = document.getElementById('telegramNotifyToggle');
  const tgLabel  = document.getElementById('telegramSwitchLabel');
  if (tgToggle && tgLabel) {
    tgToggle.addEventListener('change', () => {
      tgLabel.textContent       = tgToggle.checked ? 'Enabled' : 'Disabled';
      tgLabel.style.background  = tgToggle.checked ? 'var(--cyan)' : '';
      tgLabel.style.color       = tgToggle.checked ? '#fff' : '';
    });
  }

  // Save & test Telegram buttons
  document.getElementById('saveTelegramBtn')?.addEventListener('click', saveTelegramConfig);
  document.getElementById('testTelegramBtn')?.addEventListener('click', testTelegram);

  // Google / YouTube handlers
  document.getElementById('saveGoogleBtn')?.addEventListener('click', saveGoogleConfig);
  document.getElementById('testGoogleBtn')?.addEventListener('click', testGoogleApi);
  document.getElementById('toggleGoogleSecretVisibility')?.addEventListener('click', () => {
    const input = document.getElementById('googleClientSecretInput');
    const btn = document.getElementById('toggleGoogleSecretVisibility');
    if (input) {
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      if (btn) btn.textContent = isPass ? '🔒' : '👁️';
    }
  });

  // OpenAI handlers
  document.getElementById('saveOpenAiBtn')?.addEventListener('click', saveOpenAiConfig);
  document.getElementById('testOpenAiBtn')?.addEventListener('click', testOpenAi);
  document.getElementById('toggleOpenAiKeyVisibility')?.addEventListener('click', () => {
    const input = document.getElementById('openaiApiKeyInput');
    const btn = document.getElementById('toggleOpenAiKeyVisibility');
    if (input) {
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      if (btn) btn.textContent = isPass ? '🔒' : '👁️';
    }
  });

  // Safe Mode toggle
  const smToggle = document.getElementById('safeModeToggle');
  const smLabel  = document.getElementById('safeModeSwitchLabel');
  if (smToggle && smLabel) {
    smToggle.addEventListener('change', () => {
      smLabel.textContent      = smToggle.checked ? 'Enabled' : 'Disabled';
      smLabel.style.background = smToggle.checked ? 'var(--green)' : 'var(--bg-input)';
      smLabel.style.color      = smToggle.checked ? '#fff' : '';
    });
  }
  document.getElementById('saveAntiBanBtn')?.addEventListener('click', saveAntiBanConfig);
}

async function loadSettings() {
  try {
    const res = await api('/api/config');
    const cfg = await res.json();
    const kwRes = await api('/api/keywords');
    const kw    = await kwRes.json();
    document.getElementById('keywordsTextarea').value = kw.join('\n');

    // Populate Anti-Ban fields
    const smToggle = document.getElementById('safeModeToggle');
    const smLabel  = document.getElementById('safeModeSwitchLabel');
    if (smToggle) {
      smToggle.checked = cfg.safeModeEnabled !== false;
      if (smLabel) {
        smLabel.textContent      = smToggle.checked ? 'Enabled' : 'Disabled';
        smLabel.style.background = smToggle.checked ? 'var(--green)' : 'var(--bg-input)';
        smLabel.style.color      = smToggle.checked ? '#fff' : '';
      }
    }
    setVal('postDelayMinInput',   Math.round((cfg.postDelayMin  || 60000)  / 1000));
    setVal('postDelayMaxInput',   Math.round((cfg.postDelayMax  || 120000) / 1000));
    setVal('dailyLimitInput',     cfg.dailyLimitPerAccount || 30);
    setVal('cooldownHoursInput',  cfg.accountCooldownHours || 0);
    const kmr = document.getElementById('keywordMixRatioInput');
    const kml = document.getElementById('keywordMixLabel');
    if (kmr) { kmr.value = cfg.keywordMixRatio || 80; }
    if (kml) { kml.textContent = cfg.keywordMixRatio || 80; }

    // Populate proxy form
    const toggle      = document.getElementById('proxyEnabledToggle');
    const switchLabel = document.getElementById('proxySwitchLabel');
    if (toggle) {
      toggle.checked = !!cfg.proxyEnabled;
      if (switchLabel) {
        switchLabel.textContent = cfg.proxyEnabled ? 'Enabled' : 'Disabled';
        switchLabel.style.background = cfg.proxyEnabled ? 'var(--green)' : '';
        switchLabel.style.color = cfg.proxyEnabled ? '#fff' : '';
      }
    }
    setVal('proxyHostInput',     cfg.proxyHost     || '');
    setVal('proxyPortInput',     cfg.proxyPort     || '');
    setVal('proxyUsernameInput', cfg.proxyUsername || '');
    setVal('proxyPasswordInput', cfg.proxyPassword || '');

    // Populate Telegram form
    const tgToggle = document.getElementById('telegramNotifyToggle');
    const tgLabel  = document.getElementById('telegramSwitchLabel');
    if (tgToggle) {
      tgToggle.checked = !!cfg.telegramNotifyEnabled;
      if (tgLabel) {
        tgLabel.textContent      = cfg.telegramNotifyEnabled ? 'Enabled' : 'Disabled';
        tgLabel.style.background = cfg.telegramNotifyEnabled ? 'var(--cyan)' : '';
        tgLabel.style.color      = cfg.telegramNotifyEnabled ? '#fff' : '';
      }
    }
    setVal('telegramBotTokenInput', cfg.telegramBotToken || '');
    setVal('telegramGroupIdInput',  cfg.telegramGroupId  || '');
    setVal('openaiApiKeyInput',     cfg.openaiApiKey     || '');
    setVal('googleClientIdInput',       cfg.googleClientId       || '');
    setVal('googleClientSecretInput',   cfg.googleClientSecret   || '');
    setVal('googleRedirectUriInput',    cfg.googleRedirectUri    || '');
    setVal('youtubeApiKeyInput',        cfg.youtubeApiKey        || '');

    const sel = document.getElementById('defaultCountrySelect');
    if (sel) sel.value = defaultCountry;
    loadPlatformStatuses();
  } catch { toast('Failed to load settings', 'error'); }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

async function saveGoogleConfig() {
  const btn = document.getElementById('saveGoogleBtn');
  btn.disabled = true; btn.textContent = '⏳ Saving...';
  try {
    const clientId     = document.getElementById('googleClientIdInput')?.value.trim()     || '';
    const clientSecret = document.getElementById('googleClientSecretInput')?.value.trim() || '';
    const redirectUri  = document.getElementById('googleRedirectUriInput')?.value.trim()  || '';
    const apiKey       = document.getElementById('youtubeApiKeyInput')?.value.trim()       || '';

    const res = await api('/api/config', 'POST', {
      googleClientId:     clientId,
      googleClientSecret: clientSecret,
      googleRedirectUri:  redirectUri,
      youtubeApiKey:      apiKey,
    });

    if (res.ok) {
      toast('✅ Google & YouTube credentials saved to .env!', 'success');
      testGoogleApi();
    } else {
      toast('❌ Failed to save Google credentials', 'error');
    }
  } catch {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save Google Settings';
  }
}

async function testGoogleApi() {
  const btn = document.getElementById('testGoogleBtn');
  const resultSpan = document.getElementById('googleTestResult');
  const apiKey   = document.getElementById('youtubeApiKeyInput')?.value.trim();
  const clientId = document.getElementById('googleClientIdInput')?.value.trim();

  btn.disabled = true; btn.textContent = '⚡ Testing...';
  if (resultSpan) {
    resultSpan.textContent = 'Testing credentials...';
    resultSpan.style.color = 'var(--text-muted)';
  }
  try {
    const res = await api('/api/google/test', 'POST', { apiKey, clientId });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast('✅ Google / YouTube configuration is valid!', 'success');
      if (resultSpan) {
        resultSpan.textContent = '✅ ' + (data.message || 'Valid & Connected!');
        resultSpan.style.color = 'var(--green)';
      }
    } else {
      toast(`⚠️ ${data.message || 'Verification failed'}`, 'warn');
      if (resultSpan) {
        resultSpan.textContent = '⚠️ ' + (data.message || 'Failed');
        resultSpan.style.color = 'var(--yellow, #f59e0b)';
      }
    }
  } catch {
    toast('Network error', 'error');
    if (resultSpan) {
      resultSpan.textContent = '❌ Network error';
      resultSpan.style.color = 'var(--red)';
    }
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Test API Key';
  }
}

async function saveOpenAiConfig() {
  const btn = document.getElementById('saveOpenAiBtn');
  btn.disabled = true; btn.textContent = '⏳ Saving...';
  try {
    const key = document.getElementById('openaiApiKeyInput')?.value.trim() || '';
    const res = await api('/api/config', 'POST', { openaiApiKey: key });
    if (res.ok) {
      toast('✅ OpenAI API key saved to .env!', 'success');
      testOpenAi();
    } else {
      toast('❌ Failed to save OpenAI key', 'error');
    }
  } catch {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save OpenAI Key';
  }
}

async function testOpenAi() {
  const btn = document.getElementById('testOpenAiBtn');
  const resultSpan = document.getElementById('openAiTestResult');
  const apiKey = document.getElementById('openaiApiKeyInput')?.value.trim();
  btn.disabled = true; btn.textContent = '⚡ Testing...';
  if (resultSpan) {
    resultSpan.textContent = 'Testing connection...';
    resultSpan.style.color = 'var(--text-muted)';
  }
  try {
    const res = await api('/api/openai/test', 'POST', { openaiApiKey: apiKey });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast('✅ OpenAI API key is active & working!', 'success');
      if (resultSpan) {
        resultSpan.textContent = '✅ ' + (data.message || 'Valid & Connected!');
        resultSpan.style.color = 'var(--green)';
      }
    } else {
      toast(`❌ ${data.message || 'OpenAI verification failed'}`, 'error');
      if (resultSpan) {
        resultSpan.textContent = '❌ ' + (data.message || 'Failed');
        resultSpan.style.color = 'var(--red)';
      }
    }
  } catch {
    toast('Network error', 'error');
    if (resultSpan) {
      resultSpan.textContent = '❌ Network error';
      resultSpan.style.color = 'var(--red)';
    }
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Test Key';
  }
}

async function saveProxyConfig() {
  const btn = document.getElementById('saveProxyBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Saving...';
  try {
    const res = await api('/api/config', 'POST', {
      proxyEnabled: document.getElementById('proxyEnabledToggle')?.checked || false,
      proxyHost:     document.getElementById('proxyHostInput')?.value.trim()     || '',
      proxyPort:     document.getElementById('proxyPortInput')?.value.trim()     || '',
      proxyUsername: document.getElementById('proxyUsernameInput')?.value.trim() || '',
      proxyPassword: document.getElementById('proxyPasswordInput')?.value.trim() || '',
    });
    if (res.ok) toast('✅ Proxy settings saved!', 'success');
    else        toast('❌ Failed to save proxy', 'error');
  } catch {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Save Proxy Settings';
  }
}

async function testProxyConfig() {
  const btn = document.getElementById('testProxyBtn');
  const resSpan = document.getElementById('proxyTestResult');
  btn.disabled = true;
  btn.textContent = '⏳ Testing...';
  if (resSpan) resSpan.textContent = '';

  try {
    const res = await api('/api/proxy/test', 'POST', {
      host:     document.getElementById('proxyHostInput')?.value.trim()     || '',
      port:     document.getElementById('proxyPortInput')?.value.trim()     || '',
      username: document.getElementById('proxyUsernameInput')?.value.trim() || '',
      password: document.getElementById('proxyPasswordInput')?.value.trim() || '',
    });
    const data = await res.json();
    if (data.ok) {
      toast(`✅ Proxy connected! IP: ${data.ip}`, 'success');
      if (resSpan) {
        resSpan.style.color = '#10b981';
        resSpan.textContent = `✅ Connected! IP: ${data.ip}`;
      }
    } else {
      toast(`❌ Proxy failed: ${data.message}`, 'error');
      if (resSpan) {
        resSpan.style.color = '#ef4444';
        resSpan.textContent = `❌ ${data.message}`;
      }
    }
  } catch (e) {
    toast(`Network error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔌 Test Proxy Connection';
  }
}

async function saveTelegramConfig() {
  const btn = document.getElementById('saveTelegramBtn');
  btn.disabled = true; btn.textContent = '⏳ Saving...';
  try {
    const res = await api('/api/config', 'POST', {
      telegramNotifyEnabled: document.getElementById('telegramNotifyToggle')?.checked || false,
      telegramBotToken:      document.getElementById('telegramBotTokenInput')?.value.trim() || '',
      telegramGroupId:       document.getElementById('telegramGroupIdInput')?.value.trim()  || '',
    });
    if (res.ok) toast('✅ Telegram settings saved!', 'success');
    else        toast('❌ Failed to save Telegram settings', 'error');
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; btn.textContent = '💾 Save Telegram'; }
}

async function testTelegram() {
  const btn = document.getElementById('testTelegramBtn');
  btn.disabled = true; btn.textContent = '📨 Sending...';
  try {
    const res = await api('/api/telegram/test', 'POST', {});
    if (res.ok) toast('✅ Test message sent! Check your Telegram group.', 'success');
    else {
      const data = await res.json();
      toast(`❌ ${data.error || 'Failed to send test message'}`, 'error');
    }
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; btn.textContent = '📨 Send Test Message'; }
}

async function saveAntiBanConfig() {
  const btn = document.getElementById('saveAntiBanBtn');
  btn.disabled = true; btn.textContent = '⏳ Saving...';
  try {
    const minSec = parseFloat(document.getElementById('postDelayMinInput')?.value) || 60;
    const maxSec = parseFloat(document.getElementById('postDelayMaxInput')?.value) || 120;
    const res = await api('/api/config', 'POST', {
      safeModeEnabled:      document.getElementById('safeModeToggle')?.checked ?? true,
      postDelayMin:         Math.round(minSec * 1000),
      postDelayMax:         Math.round(maxSec * 1000),
      dailyLimitPerAccount: parseInt(document.getElementById('dailyLimitInput')?.value)     || 30,
      accountCooldownHours: parseFloat(document.getElementById('cooldownHoursInput')?.value) || 0,
      keywordMixRatio:      parseInt(document.getElementById('keywordMixRatioInput')?.value) || 80,
    });
    if (res.ok) toast('✅ Anti-Ban settings saved!', 'success');
    else        toast('❌ Failed to save settings', 'error');
  } catch { toast('Network error', 'error'); }
  finally { btn.disabled = false; btn.textContent = '💾 Save Anti-Ban Settings'; }
}

// ─── Platform Toggles ────────────────────────────────────────
async function loadPlatforms() {
  try {
    const res = await api('/api/platforms');
    allPlatforms = await res.json();
    renderPlatformToggles();
  } catch {
    document.getElementById('platformToggles').innerHTML =
      '<span class="platform-skeleton">Could not load platforms</span>';
  }
}

function renderPlatformToggles() {
  const container = document.getElementById('platformToggles');
  if (!container) return;
  container.innerHTML = allPlatforms.map(p => {
    const active = selectedPlatforms.has(p.id) ? 'active' : '';
    const dotClass = p.configured ? 'ok' : 'err';
    return `
      <button class="platform-btn ${active}" data-id="${p.id}" data-color="${p.id}"
        title="${p.name} — ${p.configured ? 'Configured' : 'Not configured'}">
        <span class="p-status-dot ${dotClass}"></span>
        <span>${p.icon} ${p.name}</span>
      </button>`;
  }).join('');

  container.querySelectorAll('.platform-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (selectedPlatforms.has(id)) {
        if (selectedPlatforms.size === 1) { toast('Select at least one platform', 'warn'); return; }
        selectedPlatforms.delete(id);
        btn.classList.remove('active');
      } else {
        selectedPlatforms.add(id);
        btn.classList.add('active');
      }
      localStorage.setItem('selectedPlatforms', JSON.stringify(Array.from(selectedPlatforms)));
    });
  });
}

async function loadPlatformStatuses() {
  const el = document.getElementById('platformStatusList');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';

  try {
    const res       = await api('/api/platforms');
    const platforms = await res.json();
    allPlatforms    = platforms; // keep in sync

    el.innerHTML = `<div class="platform-manager-list">${
      platforms.map(p => renderPlatformManagerRow(p)).join('')
    }</div>`;

    // Wire up toggle buttons
    el.querySelectorAll('.pm-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id   = btn.dataset.id;
        const form = document.getElementById(`pm-form-${id}`);
        const open = !form.classList.contains('hidden');
        // Close all others
        el.querySelectorAll('.pm-form').forEach(f => f.classList.add('hidden'));
        el.querySelectorAll('.pm-toggle-btn').forEach(b => b.textContent = '⚙️ Configure');
        if (!open) {
          form.classList.remove('hidden');
          btn.textContent = '✕ Close';
        }
      });
    });
  } catch {
    el.textContent = 'Failed to load platform statuses.';
  }
}

function renderPlatformManagerRow(p) {
  const statusBadge = p.configured
    ? `<span class="badge badge-green">✅ Connected</span>`
    : `<span class="badge badge-red">⚠️ Not configured</span>`;

  // YouTube is special — no credential form
  if (p.id === 'youtube') {
    return `
      <div class="pm-row">
        <div class="pm-row-header">
          <span class="pm-row-icon">${p.icon}</span>
          <span class="pm-row-name">${p.name}</span>
          ${statusBadge}
          <span class="pm-row-posts">${p.postsThisSession} posts</span>
          <span class="pm-row-note">Uses OAuth tokens in tokens/ folder</span>
        </div>
      </div>`;
  }

  let cookieBadge = '';
  if (p.id === 'tiktok') {
    if (p.cookieStatus && p.cookieStatus.hasCookies) {
      if (p.cookieStatus.expired) {
        cookieBadge = `<span class="badge badge-red" style="font-size: 0.75rem;" title="${p.cookieStatus.reason || 'Expired'}">🔴 Cookies Expired</span>`;
      } else {
        cookieBadge = `<span class="badge badge-green" style="font-size: 0.75rem;" title="Updated ${p.cookieStatus.ageHours}h ago">🟢 Cookies Active</span>`;
      }
    } else {
      cookieBadge = `<span class="badge badge-yellow" style="font-size: 0.75rem;">⚠️ No Cookies</span>`;
    }
  } else if (p.hasCookies) {
    cookieBadge = `<span class="badge badge-purple" style="font-size: 0.75rem;">🍪 Cookies Active</span>`;
  }

    const facebookCookieSection = p.id === 'facebook' ? `
    <div style="background: rgba(24, 119, 242, 0.06); border: 1px solid rgba(24, 119, 242, 0.25); border-radius: 8px; padding: 14px; margin-bottom: 14px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">🍪 Facebook Session Cookies</span>
        ${p.cookieStatus && p.cookieStatus.hasCookies ? (
          p.cookieStatus.expired
            ? `<span class="badge badge-red" style="font-size: 0.72rem;">⚠️ Expired (${p.cookieStatus.message || 'Session expired'})`
            : `<span class="badge badge-green" style="font-size: 0.72rem;">✅ Active (${p.cookieStatus.cookieCount} cookies)`
        ) : `<span class="badge badge-yellow" style="font-size: 0.72rem;">No cookies uploaded</span>`}
      </div>
      <p style="font-size: 0.78rem; color: #94a3b8; margin: 0 0 10px 0;">
        Export cookies from <strong>Cookie-Editor</strong> (JSON) on facebook.com and paste below, or upload the <code>.json</code> file:
      </p>
      <textarea id="facebook-cookie-input" class="custom-input" rows="4" style="font-family: monospace; font-size: 0.75rem; width: 100%; box-sizing: border-box; resize: vertical;" placeholder='Paste JSON here... [ { "name": "c_user", "value": "...", ... } ]'></textarea>
      <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary btn-sm" onclick="saveFacebookCookies()" style="background: #1877f2; border-color: #1877f2;">
          <span id="btn-save-fb-cookies-text">📥 Save Cookies</span>
        </button>
        <label class="btn btn-ghost btn-sm" style="cursor: pointer; margin: 0;">
          📁 Upload JSON <input type="file" id="facebook-cookie-file" accept=".json" style="display:none;" onchange="handleFacebookCookieFileUpload(event)">
        </label>
        <div id="facebook-cookie-msg" style="font-size: 0.8rem; margin-left: 6px;"></div>
      </div>
    </div>` : '';

  const tiktokCookieSection = p.id === 'tiktok' ? `
    <div style="background: rgba(254, 44, 85, 0.06); border: 1px solid rgba(254, 44, 85, 0.25); border-radius: 8px; padding: 14px; margin-bottom: 14px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">🍪 TikTok Session Cookies</span>
        ${p.cookieStatus && p.cookieStatus.hasCookies ? (
          p.cookieStatus.expired
            ? `<span class="badge badge-red" style="font-size: 0.72rem;">⚠️ Expired (${p.cookieStatus.reason || `${p.cookieStatus.ageHours}h ago`})</span>`
            : `<span class="badge badge-green" style="font-size: 0.72rem;">✅ Active (${p.cookieStatus.cookieCount} cookies, ${p.cookieStatus.ageHours}h ago)</span>`
        ) : `<span class="badge badge-yellow" style="font-size: 0.72rem;">No cookies uploaded</span>`}
      </div>
      <p style="font-size: 0.78rem; color: #94a3b8; margin: 0 0 10px 0;">
        Export cookies from <strong>Cookie-Editor</strong> (JSON) on tiktok.com and paste below, or upload the <code>.json</code> file:
      </p>
      <textarea id="tiktok-cookie-input" class="custom-input" rows="4" style="font-family: monospace; font-size: 0.75rem; width: 100%; box-sizing: border-box; resize: vertical;" placeholder='Paste JSON here... [ { "name": "sessionid", "value": "...", ... } ]'></textarea>
      <div style="display: flex; gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-primary btn-sm" onclick="saveTikTokCookies()" style="background: #fe2c55; border-color: #fe2c55;">
          <span id="btn-save-cookies-text">📥 Save Cookies</span>
        </button>
        <label class="btn btn-ghost btn-sm" style="cursor: pointer; margin: 0;">
          📁 Upload JSON <input type="file" id="tiktok-cookie-file" accept=".json" style="display:none;" onchange="handleCookieFileUpload(event)">
        </label>
        <div id="tiktok-cookie-msg" style="font-size: 0.8rem; margin-left: 6px;"></div>
      </div>
    </div>` : '';

  const fields = (p.credentialFields || []).map(f => `
    <div class="form-group">
      <label class="form-label">${f.label}</label>
      <input id="cred-${p.id}-${f.key}"
             type="${f.type}"
             class="custom-input"
             placeholder="${f.hasValue && f.type === 'password' ? '•••••••• (Saved)' : f.placeholder}"
             value="${f.value ? f.value.replace(/"/g, '&quot;') : ''}"
             autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" />
    </div>`).join('');

  return `
    <div class="pm-row" id="pm-row-${p.id}">
      <div class="pm-row-header">
        <span class="pm-row-icon">${p.icon}</span>
        <span class="pm-row-name">${p.name}</span>
        ${statusBadge}
        ${cookieBadge}
        <span class="pm-row-posts">${p.postsThisSession} posts</span>
        <button class="btn btn-ghost btn-sm pm-toggle-btn" data-id="${p.id}">⚙️ Configure</button>
      </div>
      <div class="pm-form hidden" id="pm-form-${p.id}">
        <div class="pm-form-inner">
          ${tiktokCookieSection}
          ${facebookCookieSection}
          ${fields}
          <div class="pm-form-actions">
            <button class="btn btn-primary btn-sm" onclick="savePlatformCredentials('${p.id}')">
              <span id="pm-save-text-${p.id}">💾 Save & Test</span>
            </button>
            <div class="pm-test-result" id="pm-result-${p.id}"></div>
          </div>
        </div>
      </div>
    </div>`;
}

async function savePlatformCredentials(id) {
  const p = allPlatforms.find(x => x.id === id);
  if (!p) return;

  // Collect field values
  const credentials = {};
  let hasValue = false;
  for (const field of (p.credentialFields || [])) {
    const input = document.getElementById(`cred-${id}-${field.key}`);
    if (input && input.value.trim()) {
      credentials[field.key] = input.value.trim();
      hasValue = true;
    }
  }

  if (!hasValue) { toast('Please fill in at least one field', 'warn'); return; }

  const saveBtn  = document.getElementById(`pm-save-text-${id}`);
  const resultEl = document.getElementById(`pm-result-${id}`);

  saveBtn.textContent = '⏳ Saving & Testing...';
  resultEl.innerHTML  = '';

  try {
    const res    = await api(`/api/platforms/${id}/credentials`, 'POST', credentials);
    const result = await res.json();

    if (result.ok) {
      saveBtn.textContent = '💾 Save & Test';
      resultEl.innerHTML  = `
        <div class="pm-result-ok">
          <span class="pm-result-icon">✅</span>
          <span>${result.message}</span>
        </div>`;
      // Update badge in header
      const badge = document.querySelector(`#pm-row-${id} .badge`);
      if (badge) { badge.className = 'badge badge-green'; badge.textContent = '✅ Connected'; }
      // Update platform toggle dot
      renderPlatformToggles();
      toast(`✅ ${p.name} connected successfully!`, 'success', 4000);
    } else {
      saveBtn.textContent = '💾 Save & Test';
      resultEl.innerHTML  = `
        <div class="pm-result-err">
          <span class="pm-result-icon">❌</span>
          <span>${result.message}</span>
        </div>`;
      toast(`❌ ${p.name}: ${result.message}`, 'error', 5000);
    }
  } catch (err) {
    saveBtn.textContent = '💾 Save & Test';
    resultEl.innerHTML  = `<div class="pm-result-err"><span>❌ Network error: ${err.message}</span></div>`;
  }
}

async function testPlatform(id) {
  const p = allPlatforms.find(x => x.id === id);
  toast(`🔌 Testing ${p?.icon} ${p?.name || id}...`, 'info');
  try {
    const res    = await api(`/api/platforms/${id}/test`, 'POST');
    const result = await res.json();
    toast(result.ok ? `✅ ${p?.name}: ${result.message}` : `❌ ${p?.name}: ${result.message}`,
          result.ok ? 'success' : 'error', 5000);
    loadPlatformStatuses();
  } catch (err) {
    toast(`❌ Test failed: ${err.message}`, 'error');
  }
}


async function saveKeywords() {
  const raw = document.getElementById('keywordsTextarea').value;
  const kw  = raw.split('\n').map(k => k.trim()).filter(Boolean);

  if (kw.length === 0) { toast('Enter at least one keyword', 'warn'); return; }

  try {
    const res = await api('/api/keywords', 'POST', { keywords: kw });
    if (res.ok) {
      toast('✅ Keywords saved!', 'success');
      loadKeywordBadges();
    } else toast('Failed to save keywords', 'error');
  } catch { toast('Network error', 'error'); }
}

async function saveConfig() {
  const delay = parseInt(document.getElementById('postDelayInput').value);
  if (isNaN(delay) || delay < 1000) { toast('Delay must be at least 1000ms', 'warn'); return; }

  try {
    const res = await api('/api/config', 'POST', { postDelay: delay });
    if (res.ok) toast('✅ Config saved!', 'success');
    else        toast('Failed to save config', 'error');
  } catch { toast('Network error', 'error'); }
}

function saveDefaultCountry() {
  const code = document.getElementById('defaultCountrySelect').value;
  defaultCountry = code;
  localStorage.setItem('defaultCountry', code);
  // Sync all selectors
  ['globalCountrySelect', 'postCountrySelect', 'trendingCountrySelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = code;
  });
  updateLanguageHint();
  toast('✅ Default country saved!', 'success');
}

// ─── Terminal Log ────────────────────────────────────────────
function appendLog(entry, terminalId) {
  const el = document.getElementById(terminalId);
  if (!el) return;

  const ts   = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  line.className = `terminal-line ${entry.level}`;
  line.innerHTML = `<span class="ts">${ts}</span><span class="msg">${escHtml(entry.message)}</span>`;
  el.appendChild(line);

  // Auto-scroll
  el.scrollTop = el.scrollHeight;

  // Limit DOM size
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

// ─── Clock ───────────────────────────────────────────────────
function updateClock() {
  const el = document.getElementById('liveClock');
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  }
}

// ─── Toast Notifications ────────────────────────────────────
function toast(message, type = 'info', duration = 3500) {
  const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ─── API Helper ──────────────────────────────────────────────
function api(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken || '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(path, opts);
}

// ─── Utilities ───────────────────────────────────────────────
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(str) {
  return escHtml(str);
}

function timeAgo(date) {
  if (!date) return 'Never';
  const d = new Date(date);
  if (isNaN(d.getTime())) return 'Never';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Expose for inline onclick handlers
window.deleteAccount             = deleteAccount;
window.switchTab                 = switchTab;
window.toggleTgGroupSelect       = toggleTgGroupSelect;
window.blastSingleTelegramGroup  = blastSingleTelegramGroup;
window.editTgTarget              = editTgTarget;
window.deleteTgTarget            = deleteTgTarget;
window.openAddTgTargetModal      = openAddTgTargetModal;
window.openManageCountriesModal  = openManageCountriesModal;
window.deleteCountry             = deleteCountry;

// ─── Telegram SEO & Group Finder ──────────────────────────────
let tgDiscoveredGroups = [];
let tgSelectedHandles = new Set();

function setupTelegramSeoTab() {
  const searchBtn        = document.getElementById('tgSearchBtn');
  const inspectBtn       = document.getElementById('tgInspectBtn');
  const toggleInspectBtn = document.getElementById('toggleInspectLinksBtn');
  const masterCb         = document.getElementById('tgMasterCheckbox');
  const selectAllBtn     = document.getElementById('tgSelectAllBtn');
  const blastBtn         = document.getElementById('tgBlastBtn');

  if (searchBtn) searchBtn.addEventListener('click', loadTelegramGroups);
  if (toggleInspectBtn) {
    toggleInspectBtn.addEventListener('click', () => {
      const box = document.getElementById('tgCustomInspectBox');
      if (box) {
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
      }
    });
  }

  if (inspectBtn) inspectBtn.addEventListener('click', inspectCustomTelegramLinks);

  if (masterCb) {
    masterCb.addEventListener('change', () => {
      tgSelectedHandles.clear();
      const checkboxes = document.querySelectorAll('.tg-group-cb');
      checkboxes.forEach(cb => {
        cb.checked = masterCb.checked;
        if (masterCb.checked) tgSelectedHandles.add(cb.dataset.handle);
      });
      updateTgSelectedCount();
    });
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const checkboxes = document.querySelectorAll('.tg-group-cb');
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      checkboxes.forEach(cb => {
        cb.checked = !allChecked;
        if (!allChecked) tgSelectedHandles.add(cb.dataset.handle);
        else tgSelectedHandles.delete(cb.dataset.handle);
      });
      if (masterCb) masterCb.checked = !allChecked;
      updateTgSelectedCount();
    });
  }

  if (blastBtn) blastBtn.addEventListener('click', blastTelegramComments);

  // Group Target & Country Management buttons
  document.getElementById('btnOpenAddTgTarget')?.addEventListener('click', openAddTgTargetModal);
  document.getElementById('btnOpenManageCountries')?.addEventListener('click', openManageCountriesModal);
  document.getElementById('btnSaveTgTarget')?.addEventListener('click', saveTgTarget);
  document.getElementById('btnSaveCountry')?.addEventListener('click', saveCountry);

  // Auto-search on filter change
  document.getElementById('tgMinMembers')?.addEventListener('change', loadTelegramGroups);
  document.getElementById('tgSearchCountry')?.addEventListener('change', loadTelegramGroups);
}

function updateTgSelectedCount() {
  const badge = document.getElementById('tgSelectedCountBadge');
  if (badge) {
    badge.textContent = `${tgSelectedHandles.size} selected`;
  }
}

async function loadTelegramGroups() {
  const kw = document.getElementById('tgSearchKeyword')?.value.trim() || '';
  const country = document.getElementById('tgSearchCountry')?.value || 'ALL';
  const minMembers = document.getElementById('tgMinMembers')?.value || '1000';
  const tbody = document.getElementById('tgGroupsTableBody');
  const countBadge = document.getElementById('tgResultsCount');
  const searchBtn = document.getElementById('tgSearchBtn');

  if (searchBtn) { searchBtn.disabled = true; searchBtn.textContent = '⏳ Searching...'; }
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-cell"><div class="spinner" style="margin:20px auto;"></div>Searching & vetting high-traffic supergroups...</td></tr>`;

  try {
    const res = await api(`/api/telegram/groups?keyword=${encodeURIComponent(kw)}&country=${encodeURIComponent(country)}&minMembers=${encodeURIComponent(minMembers)}&max=30`);
    const data = await res.json();
    if (res.ok && data.ok) {
      tgDiscoveredGroups = data.groups || [];
      renderTelegramGroupsTable(tgDiscoveredGroups);
      if (countBadge) countBadge.textContent = `${tgDiscoveredGroups.length} targets found`;
      toast(`✅ Found ${tgDiscoveredGroups.length} high-traffic targets`, 'success');
    } else {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-cell" style="color:var(--red);">❌ ${data.error || 'Failed to search groups'}</td></tr>`;
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-cell" style="color:var(--red);">❌ Network error</td></tr>`;
  } finally {
    if (searchBtn) { searchBtn.disabled = false; searchBtn.textContent = '🔍 Find Groups'; }
  }
}

async function inspectCustomTelegramLinks() {
  const input = document.getElementById('tgCustomLinksInput')?.value.trim();
  if (!input) { toast('Please paste at least one Telegram link or handle', 'warn'); return; }

  const btn = document.getElementById('tgInspectBtn');
  const tbody = document.getElementById('tgGroupsTableBody');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Auditing links...'; }
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-cell"><div class="spinner" style="margin:20px auto;"></div>Auditing live Telegram links...</td></tr>`;

  try {
    const res = await api('/api/telegram/inspect', 'POST', { links: input });
    const data = await res.json();
    if (res.ok && data.ok) {
      tgDiscoveredGroups = data.groups || [];
      renderTelegramGroupsTable(tgDiscoveredGroups);
      toast(`✅ Audited ${tgDiscoveredGroups.length} custom links!`, 'success');
    } else {
      toast(`❌ ${data.error || 'Audit failed'}`, 'error');
    }
  } catch (err) {
    toast('Network error', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Inspect & Rate These Links'; }
  }
}

function renderTelegramGroupsTable(groups) {
  const tbody = document.getElementById('tgGroupsTableBody');
  if (!tbody) return;

  if (!groups || groups.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No groups found matching criteria. Try different keywords.</td></tr>`;
    return;
  }

  tbody.innerHTML = groups.map((g) => {
    const isChecked = tgSelectedHandles.has(g.handle);
    const commentsBadge = g.hasComments
      ? `<span class="badge" style="background:rgba(34,197,94,0.15);color:var(--green);border:1px solid rgba(34,197,94,0.3);" title="Replies / comments enabled">🟢 Open Comments</span>`
      : `<span class="badge" style="background:var(--bg-input);color:var(--text-muted);" title="Channel broadcast only">📢 Broadcast</span>`;

    const backlinkBadge = g.linkAllowed
      ? `<span class="badge" style="background:rgba(34,197,94,0.15);color:var(--green);">Allowed</span>`
      : `<span class="badge badge-yellow">Filtered</span>`;

    const scoreBadge = `<span class="badge" style="background:${g.seoColor}20;color:${g.seoColor};border:1px solid ${g.seoColor}40;">${g.seoBadge}</span>`;

    const audience = g.extra || (g.memberCount ? `${Number(g.memberCount).toLocaleString()} members` : 'Public Group');

    return `
      <tr>
        <td>
          <input type="checkbox" class="tg-group-cb" data-handle="${g.handle}" ${isChecked ? 'checked' : ''} onchange="toggleTgGroupSelect('${g.handle}', this.checked)" />
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${g.avatar ? `<img src="${escHtml(g.avatar)}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;" />` : `<div style="width:34px;height:34px;border-radius:50%;background:var(--cyan);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;">✈️</div>`}
            <div>
              <div style="font-weight:600;color:var(--text-primary);font-size:13.5px;">${escHtml(g.title)}</div>
              <div style="font-size:11.5px;color:var(--cyan);">@${escHtml(g.handle)}</div>
            </div>
          </div>
        </td>
        <td>
          <div style="font-weight:500;font-size:13px;">${escHtml(audience)}</div>
          ${g.onlineCount ? `<div style="font-size:11px;color:var(--green);">🟢 ${Number(g.onlineCount).toLocaleString()} online</div>` : ''}
        </td>
        <td>${commentsBadge}</td>
        <td>${backlinkBadge}</td>
        <td>${scoreBadge}</td>
        <td>
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
            <a href="${escHtml(g.url)}" target="_blank" class="btn btn-ghost btn-sm" title="Open in Telegram">🔗 Open</a>
            <button type="button" class="btn btn-secondary btn-sm" onclick="blastSingleTelegramGroup('${escHtml(g.handle)}')">💬 Blast</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="editTgTarget('${escHtml(g.handle)}')" title="Edit Group">✏️</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="deleteTgTarget('${escHtml(g.handle)}')" title="Delete Group" style="color:var(--red);">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function toggleTgGroupSelect(handle, checked) {
  if (checked) tgSelectedHandles.add(handle);
  else tgSelectedHandles.delete(handle);
  updateTgSelectedCount();
}

async function blastSingleTelegramGroup(handle) {
  tgSelectedHandles.clear();
  tgSelectedHandles.add(handle);
  updateTgSelectedCount();
  const blastBtn = document.getElementById('tgBlastBtn');
  if (blastBtn) blastBtn.scrollIntoView({ behavior: 'smooth' });
  await blastTelegramComments();
}

async function blastTelegramComments() {
  if (tgSelectedHandles.size === 0) {
    toast('Select at least one Telegram group to blast', 'warn');
    return;
  }

  const btn = document.getElementById('tgBlastBtn');
  const statusSpan = document.getElementById('tgBlastStatus');
  const backlink = document.getElementById('tgBlastBacklink')?.value.trim() || '';
  const language = document.getElementById('tgBlastLanguage')?.value || 'Indonesian';
  const customComment = document.getElementById('tgBlastCustomComment')?.value.trim() || '';

  btn.disabled = true;
  btn.textContent = `🚀 Blasting to ${tgSelectedHandles.size} target(s)...`;
  if (statusSpan) { statusSpan.textContent = 'Posting in progress...'; statusSpan.style.color = 'var(--cyan)'; }

  try {
    const res = await api('/api/telegram/post', 'POST', {
      targets: Array.from(tgSelectedHandles),
      backlink,
      language,
      comment: customComment,
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast(`✅ Blast completed! Posted to ${data.success.length} group(s).`, 'success');
      if (statusSpan) {
        statusSpan.textContent = `✅ Success: ${data.success.length}, Failed: ${data.failed.length}`;
        statusSpan.style.color = 'var(--green)';
      }
    } else {
      toast(`⚠️ Blast issue: ${data.error || 'Check status'}`, 'warn');
      if (statusSpan) {
        statusSpan.textContent = `⚠️ Error: ${data.error || 'Failed'}`;
        statusSpan.style.color = 'var(--red)';
      }
    }
  } catch (err) {
    toast('Network error during blast', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Blast Comment to Selected Groups';
  }
}

// ─── Target Groups & Countries Management Functions ─────────
function openAddTgTargetModal() {
  document.getElementById('modalTgTargetTitle').textContent = '➕ Add Telegram Target Group';
  document.getElementById('inputTgTargetHandle').value = '';
  document.getElementById('inputTgTargetHandle').disabled = false;
  document.getElementById('inputTgTargetCategory').value = 'General';
  document.getElementById('inputTgTargetNiche').value = '';
  const countrySel = document.getElementById('selectTgTargetCountry');
  if (countrySel) countrySel.value = 'GLOBAL';
  document.getElementById('modalTgTarget').classList.remove('hidden');
}

async function editTgTarget(handle) {
  try {
    const res = await api('/api/telegram/targets');
    const data = await res.json();
    const target = data.targets?.find(t => t.handle.toLowerCase() === handle.toLowerCase());
    if (target) {
      document.getElementById('modalTgTargetTitle').textContent = `✏️ Edit Target: @${target.handle}`;
      document.getElementById('inputTgTargetHandle').value = target.handle;
      document.getElementById('inputTgTargetHandle').disabled = true;
      document.getElementById('selectTgTargetCountry').value = target.country || 'GLOBAL';
      document.getElementById('inputTgTargetCategory').value = target.category || 'General';
      document.getElementById('inputTgTargetNiche').value = target.niche || '';
      document.getElementById('modalTgTarget').classList.remove('hidden');
    } else {
      document.getElementById('modalTgTargetTitle').textContent = `➕ Add Target: @${handle}`;
      document.getElementById('inputTgTargetHandle').value = handle;
      document.getElementById('inputTgTargetHandle').disabled = false;
      document.getElementById('selectTgTargetCountry').value = 'GLOBAL';
      document.getElementById('inputTgTargetCategory').value = 'General';
      document.getElementById('inputTgTargetNiche').value = handle;
      document.getElementById('modalTgTarget').classList.remove('hidden');
    }
  } catch {
    toast('Failed to load target details', 'error');
  }
}

async function saveTgTarget() {
  const handle   = document.getElementById('inputTgTargetHandle')?.value.trim();
  const country  = document.getElementById('selectTgTargetCountry')?.value || 'GLOBAL';
  const category = document.getElementById('inputTgTargetCategory')?.value.trim() || 'General';
  const niche    = document.getElementById('inputTgTargetNiche')?.value.trim() || '';

  if (!handle) { toast('Please enter a group handle or link', 'warn'); return; }

  const btn = document.getElementById('btnSaveTgTarget');
  btn.disabled = true; btn.textContent = '⏳ Saving...';

  try {
    const res = await api('/api/telegram/targets', 'POST', { handle, country, category, niche });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast(`✅ Saved target @${data.target.handle}!`, 'success');
      closeModal('modalTgTarget');
      loadTelegramGroups();
    } else {
      toast(`❌ ${data.error || 'Failed to save target'}`, 'error');
    }
  } catch {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save Target Group';
  }
}

async function deleteTgTarget(handle) {
  if (!confirm(`Are you sure you want to remove @${handle} from targets?`)) return;
  try {
    const res = await api(`/api/telegram/targets/${encodeURIComponent(handle)}`, 'DELETE');
    const data = await res.json();
    if (res.ok && data.ok) {
      toast(`🗑️ Removed @${handle}`, 'warn');
      loadTelegramGroups();
    } else {
      toast(`❌ ${data.error || 'Failed to delete'}`, 'error');
    }
  } catch {
    toast('Network error', 'error');
  }
}

function openManageCountriesModal() {
  renderCountriesTable();
  document.getElementById('modalManageCountries').classList.remove('hidden');
}

function renderCountriesTable() {
  const tbody = document.getElementById('countriesTableBody');
  const badge = document.getElementById('countryCountBadge');
  if (badge) badge.textContent = `${countries.length} countries`;
  if (!tbody) return;

  if (!countries || countries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No countries defined.</td></tr>`;
    return;
  }

  tbody.innerHTML = countries.map(c => `
    <tr>
      <td style="font-size:18px;">${escHtml(c.flag || '🌐')}</td>
      <td style="font-weight:600;">${escHtml(c.name)}</td>
      <td><code>${escHtml(c.code)}</code></td>
      <td>${escHtml(c.language || 'English')}</td>
      <td>
        <button type="button" class="btn btn-ghost btn-sm" onclick="deleteCountry('${escHtml(c.code)}')" style="color:var(--red);" title="Delete Country">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function saveCountry() {
  const code     = document.getElementById('inputNewCountryCode')?.value.trim().toUpperCase();
  const name     = document.getElementById('inputNewCountryName')?.value.trim();
  const flag     = document.getElementById('inputNewCountryFlag')?.value.trim() || '🌐';
  const language = document.getElementById('inputNewCountryLang')?.value.trim() || 'English';

  if (!code || !name) {
    toast('Code and Country Name are required', 'warn');
    return;
  }

  const btn = document.getElementById('btnSaveCountry');
  btn.disabled = true; btn.textContent = '⏳ Saving...';

  try {
    const res = await api('/api/countries', 'POST', { code, name, flag, language });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast(`✅ Saved country: ${flag} ${name} (${code})`, 'success');
      countries = data.countries;
      populateAllSelectors();
      renderCountriesTable();
      document.getElementById('inputNewCountryCode').value = '';
      document.getElementById('inputNewCountryName').value = '';
      document.getElementById('inputNewCountryFlag').value = '';
      document.getElementById('inputNewCountryLang').value = '';
    } else {
      toast(`❌ ${data.error || 'Failed to save country'}`, 'error');
    }
  } catch {
    toast('Network error', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '💾 Save';
  }
}

async function deleteCountry(code) {
  if (!confirm(`Are you sure you want to delete country ${code}?`)) return;
  try {
    const res = await api(`/api/countries/${encodeURIComponent(code)}`, 'DELETE');
    const data = await res.json();
    if (res.ok && data.ok) {
      toast(`🗑️ Deleted country ${code}`, 'warn');
      countries = data.countries;
      populateAllSelectors();
      renderCountriesTable();
    } else {
      toast(`❌ ${data.error || 'Failed to delete country'}`, 'error');
    }
  } catch {
    toast('Network error', 'error');
  }
}


// ─── TikTok Cookies Management ──────────────────────────────
async function saveTikTokCookies(explicitJson) {
  const input = document.getElementById('tiktok-cookie-input');
  const msgEl = document.getElementById('tiktok-cookie-msg');
  const btnText = document.getElementById('btn-save-cookies-text');
  const jsonStr = explicitJson || (input ? input.value.trim() : '');

  if (!jsonStr) {
    if (msgEl) msgEl.innerHTML = '<span style="color: #f87171;">⚠️ Please paste cookie JSON first</span>';
    toast('Please paste or upload cookie JSON', 'warn');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    if (msgEl) msgEl.innerHTML = `<span style="color: #f87171;">❌ Invalid JSON: ${e.message}</span>`;
    toast('Invalid JSON format', 'error');
    return;
  }

  if (btnText) btnText.textContent = '⏳ Saving...';
  if (msgEl) msgEl.innerHTML = '<span style="color: #94a3b8;">Saving cookies...</span>';

  try {
    const res = await api('/api/tiktok/cookies', 'POST', { cookies: parsed });
    const data = await res.json();
    if (data.ok) {
      if (btnText) btnText.textContent = '📥 Save Cookies';
      if (msgEl) msgEl.innerHTML = `<span style="color: #34d399;">✅ Saved ${data.status.cookieCount} cookies! Status: Active</span>`;
      if (input) input.value = '';
      toast(`TikTok cookies updated (${data.status.cookieCount} cookies)!`, 'ok');
      await loadPlatforms();
    } else {
      throw new Error(data.error || 'Failed to save');
    }
  } catch (err) {
    if (btnText) btnText.textContent = '📥 Save Cookies';
    if (msgEl) msgEl.innerHTML = `<span style="color: #f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  }
}

function handleCookieFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const input = document.getElementById('tiktok-cookie-input');
    if (input) input.value = text;
    saveTikTokCookies(text);
  };
  reader.readAsText(file);
}


// ─── TikTok Multi-Account Management ────────────────────────
async function loadTikTokAccounts() {
  const tbody = document.getElementById('tiktokAccountsBody');
  const badge = document.getElementById('tiktokAccountCountBadge');
  if (!tbody) return;

  try {
    const res = await api('/api/tiktok/accounts');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.accounts)) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Failed to load TikTok accounts.</td></tr>';
      return;
    }

    const accounts = data.accounts;
    const activeCount = accounts.filter(a => a.valid).length;
    if (badge) {
      badge.textContent = `${activeCount} active`;
      badge.className = activeCount > 0 ? 'badge badge-green' : 'badge badge-yellow';
    }

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No TikTok accounts added yet. Click "+ Add TikTok Account" to add cookies.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr>
        <td><strong>${escapeHtml(a.name)}</strong></td>
        <td><span class="badge badge-purple">${a.cookieCount} cookies</span></td>
        <td>${a.postsCount || 0}</td>
        <td>${a.lastUsed ? timeAgo(new Date(a.lastUsed)) : 'Never'}</td>
        <td>
          <span class="badge ${a.valid ? 'badge-green' : 'badge-red'}">
            ${a.valid ? '✅ Active' : '⚠️ ' + escapeHtml(a.reason || 'Expired')}
          </span>
        </td>
        <td>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteTikTokAccount('${a.id}')" title="Delete Account">🗑️</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function submitNewTikTokAccount() {
  const nameInput = document.getElementById('newTikTokAccountName');
  const cookieInput = document.getElementById('newTikTokAccountCookies');
  const msgEl = document.getElementById('newTikTokAccountMsg');
  const btn = document.getElementById('btnSaveTikTokAccount');

  const name = nameInput ? nameInput.value.trim() : '';
  const cookieStr = cookieInput ? cookieInput.value.trim() : '';

  if (!cookieStr) {
    if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">⚠️ Please paste cookie JSON</span>';
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(cookieStr);
  } catch (e) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ Invalid JSON: ${e.message}</span>`;
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }

  try {
    const res = await api('/api/tiktok/accounts', 'POST', { name, cookies: parsed });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save account');

    toast(`✅ Added TikTok account "${data.account.name}"!`, 'success');
    if (nameInput) nameInput.value = '';
    if (cookieInput) cookieInput.value = '';
    if (msgEl) msgEl.innerHTML = '';
    closeModal('addTikTokAccountModal');
    loadTikTokAccounts();
    if (typeof loadPlatforms === 'function') loadPlatforms();
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Save Account'; }
  }
}

function handleNewTikTokAccountFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const msgEl = document.getElementById('newTikTokAccountFileMsg');
  if (msgEl) msgEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const input = document.getElementById('newTikTokAccountCookies');
    if (input) input.value = text;
  };
  reader.readAsText(file);
}

async function deleteTikTokAccount(id) {
  if (!confirm('Are you sure you want to remove this TikTok account?')) return;
  try {
    const res = await api(`/api/tiktok/accounts/${id}`, 'DELETE');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to delete');
    toast('TikTok account deleted', 'info');
    loadTikTokAccounts();
    if (typeof loadPlatforms === 'function') loadPlatforms();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  }
}


// ─── Facebook Multi-Account Management ───────────────────────
async function loadFacebookAccounts() {
  const tbody = document.getElementById('facebookAccountsBody');
  const badge = document.getElementById('facebookAccountCountBadge');
  if (!tbody) return;

  try {
    const res = await api('/api/facebook/accounts');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.accounts)) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Failed to load Facebook accounts.</td></tr>';
      return;
    }

    const accounts = data.accounts;
    const activeCount = accounts.filter(a => a.valid).length;
    if (badge) {
      badge.textContent = `${activeCount} active`;
      badge.className = activeCount > 0 ? 'badge badge-green' : 'badge badge-yellow';
    }

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No Facebook accounts added yet. Click "+ Add Facebook Account" to add cookies.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr>
        <td><strong>${escapeHtml(a.name)}</strong></td>
        <td><span class="badge badge-purple">${a.cookieCount} cookies</span></td>
        <td>${a.postsCount || 0}</td>
        <td>${a.lastUsed ? timeAgo(new Date(a.lastUsed)) : 'Never'}</td>
        <td>
          <span class="badge ${a.valid ? 'badge-green' : 'badge-red'}">
            ${a.valid ? '✅ Active' : '⚠️ ' + escapeHtml(a.reason || 'Expired')}
          </span>
        </td>
        <td>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="deleteFacebookAccount('${a.id}')" title="Delete Account">🗑️</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function submitNewFacebookAccount() {
  const nameInput = document.getElementById('newFacebookAccountName');
  const cookieInput = document.getElementById('newFacebookAccountCookies');
  const msgEl = document.getElementById('newFacebookAccountMsg');
  const btn = document.getElementById('btnSaveFacebookAccount');

  const name = nameInput ? nameInput.value.trim() : '';
  const cookieStr = cookieInput ? cookieInput.value.trim() : '';

  if (!cookieStr) {
    if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">⚠️ Please paste cookie JSON</span>';
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(cookieStr);
  } catch (e) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ Invalid JSON: ${e.message}</span>`;
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }

  try {
    const res = await api('/api/facebook/accounts', 'POST', { name, cookies: parsed });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save account');

    toast(`✅ Added Facebook account "${data.account.name}"!`, 'success');
    if (nameInput) nameInput.value = '';
    if (cookieInput) cookieInput.value = '';
    if (msgEl) msgEl.innerHTML = '';
    closeModal('addFacebookAccountModal');
    loadFacebookAccounts();
    if (typeof loadPlatforms === 'function') loadPlatforms();
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Save Account'; }
  }
}

function handleNewFacebookAccountFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const msgEl = document.getElementById('newFacebookAccountFileMsg');
  if (msgEl) msgEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const input = document.getElementById('newFacebookAccountCookies');
    if (input) input.value = text;
  };
  reader.readAsText(file);
}

async function deleteFacebookAccount(id) {
  if (!confirm('Are you sure you want to remove this Facebook account?')) return;
  try {
    const res = await api(`/api/facebook/accounts/${id}`, 'DELETE');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to delete');
    toast('Facebook account deleted', 'info');
    loadFacebookAccounts();
    if (typeof loadPlatforms === 'function') loadPlatforms();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  }
}

async function saveFacebookCookies(explicitJson) {
  const input = document.getElementById('facebook-cookie-input');
  const msgEl = document.getElementById('facebook-cookie-msg');
  const btnText = document.getElementById('btn-save-fb-cookies-text');
  const jsonStr = explicitJson || (input ? input.value.trim() : '');

  if (!jsonStr) {
    if (msgEl) msgEl.innerHTML = '<span style="color: #f87171;">⚠️ Please paste cookie JSON</span>';
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    if (msgEl) msgEl.innerHTML = `<span style="color: #f87171;">❌ Invalid JSON: ${e.message}</span>`;
    return;
  }

  if (btnText) btnText.textContent = '⏳ Saving...';

  try {
    const res = await api('/api/facebook/cookies', 'POST', { cookies: parsed });
    const data = await res.json();
    if (data.ok) {
      if (btnText) btnText.textContent = '📥 Save Cookies';
      if (msgEl) msgEl.innerHTML = `<span style="color: #34d399;">✅ Saved ${data.status.cookieCount} cookies! Status: Active</span>`;
      if (input) input.value = '';
      toast(`Facebook cookies updated (${data.status.cookieCount} cookies)!`, 'ok');
      await loadPlatforms();
      loadFacebookAccounts();
    } else {
      throw new Error(data.error || 'Failed to save');
    }
  } catch (err) {
    if (btnText) btnText.textContent = '📥 Save Cookies';
    if (msgEl) msgEl.innerHTML = `<span style="color: #f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  }
}

function handleFacebookCookieFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const input = document.getElementById('facebook-cookie-input');
    if (input) input.value = text;
    saveFacebookCookies(text);
  };
  reader.readAsText(file);
}

// ─── Instagram Multi-Account Management ─────────────────────
async function loadInstagramAccounts() {
  const tbody = document.getElementById('instagramAccountsBody');
  const badge = document.getElementById('instagramAccountCountBadge');
  if (!tbody) return;

  try {
    const res = await api('/api/instagram/accounts');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.accounts)) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Failed to load Instagram accounts.</td></tr>';
      return;
    }

    const accounts = data.accounts;
    const activeCount = accounts.filter(a => a.valid).length;
    if (badge) {
      badge.textContent = `${activeCount} active`;
      badge.className = activeCount > 0 ? 'badge badge-green' : 'badge badge-yellow';
    }

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No Instagram accounts added yet. Click "+ Add Instagram Account" to add via cookies or login.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr data-account-id="${a.id}">
        <td><strong>${escHtml(a.name)}</strong></td>
        <td><code>${a.username ? '@' + escHtml(a.username) : 'N/A'}</code></td>
        <td>${a.cookieCount > 0 ? `<span class="badge badge-purple">${a.cookieCount} Cookies</span>` : (a.hasCredentials ? '<span class="badge badge-cyan">User/Pass</span>' : '<span class="badge badge-yellow">None</span>')}</td>
        <td><strong>${a.postsCount || 0}</strong></td>
        <td>${a.lastUsed ? timeAgo(a.lastUsed) : '<span class="text-muted">Never</span>'}</td>
        <td>${a.valid ? '<span class="badge badge-green">● Active</span>' : '<span class="badge badge-red">● Expired</span>'}</td>
        <td>
          ${a.id !== 'env_default' ? `<button class="btn btn-danger btn-sm" onclick="deleteInstagramAccount('${a.id}')">🗑️ Remove</button>` : '<span class="badge badge-cyan">.env Default</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Error loading Instagram accounts: ${err.message}</td></tr>`;
  }
}

async function submitNewInstagramAccount() {
  const nameInput = document.getElementById('newInstagramAccountName');
  const cookiesInput = document.getElementById('newInstagramAccountCookies');
  const userInput = document.getElementById('newInstagramUsername');
  const passInput = document.getElementById('newInstagramPassword');
  const msgEl = document.getElementById('newInstagramAccountMsg');
  const btn = document.getElementById('btnSaveInstagramAccount');

  const name = nameInput ? nameInput.value.trim() : '';
  const cookiesRaw = cookiesInput ? cookiesInput.value.trim() : '';
  const username = userInput ? userInput.value.trim() : '';
  const password = passInput ? passInput.value.trim() : '';

  if (!cookiesRaw && (!username || !password)) {
    if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">⚠️ Please paste cookie JSON or enter username & password</span>';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }
  if (msgEl) msgEl.innerHTML = '';

  try {
    let parsedCookies = null;
    if (cookiesRaw) {
      try {
        parsedCookies = JSON.parse(cookiesRaw);
      } catch (e) {
        throw new Error('Invalid JSON format for cookies');
      }
    }

    const res = await api('/api/instagram/accounts', 'POST', {
      name: name || (username ? `@${username}` : 'Instagram Account'),
      cookies: parsedCookies,
      username,
      password,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save account');

    toast(`✅ Instagram account "${name || 'Account'}" added!`, 'success');
    closeModal('addInstagramAccountModal');
    if (nameInput) nameInput.value = '';
    if (cookiesInput) cookiesInput.value = '';
    if (userInput) userInput.value = '';
    if (passInput) passInput.value = '';
    loadInstagramAccounts();
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Save Account'; }
  }
}

function handleNewInstagramAccountFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const msgEl = document.getElementById('newInstagramAccountFileMsg');
  if (msgEl) msgEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const input = document.getElementById('newInstagramAccountCookies');
    if (input) input.value = text;
  };
  reader.readAsText(file);
}

async function deleteInstagramAccount(id) {
  if (!confirm('Remove this Instagram account?')) return;
  try {
    const res = await api(`/api/instagram/accounts/${id}`, 'DELETE');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to delete');
    toast('Instagram account removed', 'info');
    loadInstagramAccounts();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  }
}

// ─── Twitter / X Multi-Account Management ───────────────────
async function loadTwitterAccounts() {
  const tbody = document.getElementById('twitterAccountsBody');
  const badge = document.getElementById('twitterAccountCountBadge');
  if (!tbody) return;

  try {
    const res = await api('/api/twitter/accounts');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.accounts)) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Failed to load Twitter / X accounts.</td></tr>';
      return;
    }

    const accounts = data.accounts;
    const activeCount = accounts.filter(a => a.valid).length;
    if (badge) {
      badge.textContent = `${activeCount} active`;
      badge.className = activeCount > 0 ? 'badge badge-green' : 'badge badge-yellow';
    }

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No Twitter / X accounts added yet. Click "+ Add Twitter / X Account" to add API profiles.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr data-account-id="${a.id}">
        <td><strong>${escHtml(a.name)}</strong></td>
        <td><code>${a.username ? (a.username.startsWith('@') ? escHtml(a.username) : '@' + escHtml(a.username)) : 'API App'}</code></td>
        <td><code>${escHtml(a.apiKeyMasked || '••••')}</code></td>
        <td><strong>${a.postsCount || 0}</strong></td>
        <td>${a.lastUsed ? timeAgo(a.lastUsed) : '<span class="text-muted">Never</span>'}</td>
        <td>${a.valid ? '<span class="badge badge-green">● Ready</span>' : '<span class="badge badge-red">● Inactive</span>'}</td>
        <td>
          ${a.id !== 'env_default' ? `<button class="btn btn-danger btn-sm" onclick="deleteTwitterAccount('${a.id}')">🗑️ Remove</button>` : '<span class="badge badge-cyan">.env Default</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Error loading Twitter / X accounts: ${err.message}</td></tr>`;
  }
}

async function submitNewTwitterAccount() {
  const name = document.getElementById('newTwitterAccountName')?.value.trim();
  const username = document.getElementById('newTwitterAccountUsername')?.value.trim();
  const apiKey = document.getElementById('newTwitterApiKey')?.value.trim();
  const apiSecret = document.getElementById('newTwitterApiSecret')?.value.trim();
  const accessToken = document.getElementById('newTwitterAccessToken')?.value.trim();
  const accessSecret = document.getElementById('newTwitterAccessSecret')?.value.trim();
  const msgEl = document.getElementById('newTwitterAccountMsg');
  const btn = document.getElementById('btnSaveTwitterAccount');

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">⚠️ API Key, API Secret, Access Token, and Access Token Secret are required</span>';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }
  if (msgEl) msgEl.innerHTML = '';

  try {
    const res = await api('/api/twitter/accounts', 'POST', {
      name: name || username || 'X Account',
      username,
      apiKey,
      apiSecret,
      accessToken,
      accessSecret,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save account');

    toast(`✅ Twitter / X account "${name || 'Account'}" added!`, 'success');
    closeModal('addTwitterAccountModal');
    loadTwitterAccounts();
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Save Account'; }
  }
}

async function deleteTwitterAccount(id) {
  if (!confirm('Remove this Twitter / X account?')) return;
  try {
    const res = await api(`/api/twitter/accounts/${id}`, 'DELETE');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to delete');
    toast('Twitter / X account removed', 'info');
    loadTwitterAccounts();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  }
}

// ─── Reddit Multi-Account Management ────────────────────────
async function loadRedditAccounts() {
  const tbody = document.getElementById('redditAccountsBody');
  const badge = document.getElementById('redditAccountCountBadge');
  if (!tbody) return;

  try {
    const res = await api('/api/reddit/accounts');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.accounts)) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Failed to load Reddit accounts.</td></tr>';
      return;
    }

    const accounts = data.accounts;
    const activeCount = accounts.filter(a => a.valid).length;
    if (badge) {
      badge.textContent = `${activeCount} active`;
      badge.className = activeCount > 0 ? 'badge badge-green' : 'badge badge-yellow';
    }

    if (accounts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No Reddit accounts added yet. Click "+ Add Reddit Account" to add script app credentials.</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map(a => `
      <tr data-account-id="${a.id}">
        <td><strong>${escHtml(a.name)}</strong></td>
        <td><code>${escHtml(a.username || 'N/A')}</code></td>
        <td><code>${escHtml(a.clientIdMasked || '••••')}</code></td>
        <td><strong>${a.postsCount || 0}</strong></td>
        <td>${a.lastUsed ? timeAgo(a.lastUsed) : '<span class="text-muted">Never</span>'}</td>
        <td>${a.valid ? '<span class="badge badge-green">● Connected</span>' : '<span class="badge badge-red">● Inactive</span>'}</td>
        <td>
          ${a.id !== 'env_default' ? `<button class="btn btn-danger btn-sm" onclick="deleteRedditAccount('${a.id}')">🗑️ Remove</button>` : '<span class="badge badge-cyan">.env Default</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Error loading Reddit accounts: ${err.message}</td></tr>`;
  }
}

async function submitNewRedditAccount() {
  const name = document.getElementById('newRedditAccountName')?.value.trim();
  const username = document.getElementById('newRedditUsername')?.value.trim();
  const password = document.getElementById('newRedditPassword')?.value.trim();
  const clientId = document.getElementById('newRedditClientId')?.value.trim();
  const clientSecret = document.getElementById('newRedditClientSecret')?.value.trim();
  const msgEl = document.getElementById('newRedditAccountMsg');
  const btn = document.getElementById('btnSaveRedditAccount');

  if (!username || !password || !clientId || !clientSecret) {
    if (msgEl) msgEl.innerHTML = '<span style="color:#f87171;">⚠️ Username, Password, Client ID, and Client Secret are required</span>';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }
  if (msgEl) msgEl.innerHTML = '';

  try {
    const res = await api('/api/reddit/accounts', 'POST', {
      name: name || `u/${username}`,
      username,
      password,
      clientId,
      clientSecret,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save account');

    toast(`✅ Reddit account "${name || username}" added!`, 'success');
    closeModal('addRedditAccountModal');
    loadRedditAccounts();
  } catch (err) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">❌ ${err.message}</span>`;
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Save Account'; }
  }
}

async function deleteRedditAccount(id) {
  if (!confirm('Remove this Reddit account?')) return;
  try {
    const res = await api(`/api/reddit/accounts/${id}`, 'DELETE');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to delete');
    toast('Reddit account removed', 'info');
    loadRedditAccounts();
  } catch (err) {
    toast(`❌ ${err.message}`, 'error');
  }
}

// Global window assignments for Facebook and TikTok management
window.escapeHtml = escapeHtml;
window.timeAgo = timeAgo;
window.loadTikTokAccounts = loadTikTokAccounts;
window.submitNewTikTokAccount = submitNewTikTokAccount;
window.handleNewTikTokAccountFileUpload = handleNewTikTokAccountFileUpload;
window.deleteTikTokAccount = deleteTikTokAccount;
window.saveTikTokCookies = saveTikTokCookies;
window.handleTikTokCookieFileUpload = handleTikTokCookieFileUpload;
window.loadFacebookAccounts = loadFacebookAccounts;
window.submitNewFacebookAccount = submitNewFacebookAccount;
window.handleNewFacebookAccountFileUpload = handleNewFacebookAccountFileUpload;
window.deleteFacebookAccount = deleteFacebookAccount;
window.saveFacebookCookies = saveFacebookCookies;
window.handleFacebookCookieFileUpload = handleFacebookCookieFileUpload;
window.loadInstagramAccounts = loadInstagramAccounts;
window.submitNewInstagramAccount = submitNewInstagramAccount;
window.handleNewInstagramAccountFileUpload = handleNewInstagramAccountFileUpload;
window.deleteInstagramAccount = deleteInstagramAccount;
window.loadTwitterAccounts = loadTwitterAccounts;
window.submitNewTwitterAccount = submitNewTwitterAccount;
window.deleteTwitterAccount = deleteTwitterAccount;
window.loadRedditAccounts = loadRedditAccounts;
window.submitNewRedditAccount = submitNewRedditAccount;
window.deleteRedditAccount = deleteRedditAccount;
window.sendAllTrendingToPostComment = sendAllTrendingToPostComment;
window.importTrendingToPostForm = importTrendingToPostForm;
