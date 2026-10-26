const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

(async () => {
    console.log('🚀 Starting Perf-Lens CI Runner...');
    
    const pathToExtension = path.resolve(__dirname, '..'); 
    const userDataDir = '/tmp/perf-lens-user-data';

    // Launch context with explicit arguments for CI
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // Must be false for extensions, xvfb provides the display
        args: [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`,
            `--no-sandbox`, // Required for GitHub Actions
            `--disable-setuid-sandbox`
        ],
        timeout: 60000 // Increase launch timeout for CI
    });

    // Wait for the extension's service worker with a timeout
    console.log('Waiting for extension service worker...');
    let sw;
    try {
        // Wait for the event with a 30s timeout
        sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
    } catch (e) {
        // Fallback: check if it already loaded
        const workers = context.serviceWorkers();
        if (workers.length > 0) sw = workers[0];
        else throw new Error('Extension service worker failed to start.');
    }

    const extensionId = sw.url().split('/')[2];
    console.log(`🔍 Extension Loaded. ID: ${extensionId}`);

    const TARGET_URL = process.env.TARGET_URL || 'https://opensource-demo.orangehrmlive.com/';
    const page = await context.newPage();
    
    console.log(`🌐 Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Start Recording
    console.log('🔴 Starting Recording...');
    await sw.evaluate(async (throttle) => {
        const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
        return new Promise(r => chrome.runtime.sendMessage({
            type: 'START_RECORDING',
            name: 'CI_Automated_Run',
            tabId: tabs[0].id,
            throttle: throttle,
            skipReload: true
        }, r));
    }, process.env.PERF_THROTTLE || 'none');

    // Wait for the settle window
    await page.waitForTimeout(2500);

    // --- YOUR TEST STEPS ---
    console.log('🤖 Simulating User Journey...');
    await page.fill('input[name="username"]', 'Admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000); // Wait longer on CI for dashboard to load

    // Stop Recording
    console.log('⏹️ Stopping Recording...');
    await sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, r)));

    // Generate Report
    console.log('📦 Generating Report...');
    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/src/panel.html`);
    
    // Wait for report to be ready (Service worker needs time to build it)
    await panelPage.waitForSelector('#downloadZipBtn', { state: 'visible', timeout: 30000 });
    
    const downloadPromise = panelPage.waitForEvent('download');
    await panelPage.click('#downloadZipBtn');
    const download = await downloadPromise;
    
    const zipPath = path.join(__dirname, 'ci-report.zip');
    await download.saveAs(zipPath);
    console.log(`📦 Report Downloaded to ${zipPath}`);

    // Parse Score
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(path.join(__dirname, 'extracted'), true);
    const reportHtml = fs.readFileSync(path.join(__dirname, 'extracted', 'report.html'), 'utf8');
    const scoreMatch = reportHtml.match(/<div class="rpt-ring-num">(\d+|—)<\/div>/);
    
    if (scoreMatch) {
        console.log(`\n========================================`);
        console.log(`📊 PERF-LENS HEALTH SCORE: ${scoreMatch[1]}/100`);
        console.log(`========================================\n`);
    }

    await context.close();
    process.exit(0);
})();