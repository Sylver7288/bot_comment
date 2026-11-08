require('dotenv').config();
const { getBrowser, newPageWithProxy, closeBrowser } = require('./platforms/browser');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

async function runDiagnostics() {
  console.log('========================================');
  console.log('🔬 TIKTOK & PROXY DEEP DIAGNOSTIC TOOL');
  console.log('========================================');

  console.log(`\n[1/3] Proxy Configuration in .env:`);
  console.log(`- Enabled:  ${process.env.PROXYLAB_ENABLED}`);
  console.log(`- Host:     ${process.env.PROXYLAB_HOST}`);
  console.log(`- Port:     ${process.env.PROXYLAB_PORT}`);
  console.log(`- Username: ${process.env.PROXYLAB_USERNAME}`);

  const proxyUrl = `http://${process.env.PROXYLAB_USERNAME}:${process.env.PROXYLAB_PASSWORD}@${process.env.PROXYLAB_HOST}:${process.env.PROXYLAB_PORT}`;
  const agent = new HttpsProxyAgent(proxyUrl);

  console.log(`\n[2/3] Testing Direct HTTP via Proxy (Axios)...`);
  try {
    const ipRes = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 10000 });
    console.log(`✅ Proxy Exit IP: ${ipRes.data.ip}`);
  } catch (e) {
    console.log(`❌ Proxy IP check failed: ${e.message}`);
  }

  try {
    const ttRes = await axios.get('https://www.tiktok.com/@tiktok', {
      httpsAgent: agent,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    console.log(`✅ Axios reach to TikTok: HTTP ${ttRes.status} OK`);
  } catch (e) {
    console.log(`❌ Axios reach to TikTok failed: HTTP ${e.response?.status || e.message}`);
  }

  console.log(`\n[3/3] Testing Puppeteer Browser (Headless Chrome)...`);
  try {
    const browser = await getBrowser();
    const page = await newPageWithProxy(browser);

    // Test A: Clean page load without cookies
    console.log(`  -> Test A: Navigating to https://www.tiktok.com/ (clean, no cookies)...`);
    const pageRes = await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(err => {
      console.log(`     page.goto error: ${err.message}`);
      return null;
    });

    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const bodySnippet = await page.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 100) : '').catch(() => '');

    console.log(`     Status: ${pageRes ? pageRes.status() : 'N/A'}`);
    console.log(`     Final URL: ${currentUrl}`);
    console.log(`     Title: "${title}"`);
    console.log(`     Content: "${bodySnippet}"`);

    if (currentUrl.startsWith('chrome-error://') || (pageRes && pageRes.status() === 403)) {
      console.log(`❌ Puppeteer was blocked by TikTok (HTTP 403) on clean load!`);
    } else {
      console.log(`✅ Puppeteer reached TikTok homepage cleanly!`);
    }

    // Test B: Test video URL
    console.log(`  -> Test B: Navigating to public video URL...`);
    const vidRes = await page.goto('https://www.tiktok.com/@tiktok/video/7311749847683976494?is_from_webapp=1&sender_device=pc', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(err => {
      console.log(`     page.goto error: ${err.message}`);
      return null;
    });

    console.log(`     Video Status: ${vidRes ? vidRes.status() : 'N/A'}`);
    console.log(`     Video Final URL: ${page.url()}`);
    console.log(`     Video Title: "${await page.title().catch(() => '')}"`);

    await closeBrowser();
  } catch (err) {
    console.log(`❌ Puppeteer test encountered error: ${err.message}`);
  }

  console.log('\n========================================');
  console.log('🏁 DIAGNOSTIC COMPLETE');
  console.log('========================================');
  process.exit(0);
}

runDiagnostics();

