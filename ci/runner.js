const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

(async () => {
    console.log('🚀 Starting Perf-Lens CI Runner...');
    
    // 1. Load the Chrome Extension
    const pathToExtension = path.resolve(__dirname, '..'); 
    const userDataDir = '/tmp/perf-lens-user-data';

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // Extensions require headful or 'new' headless mode
        args: [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`,
            `--headless=new`
        ],
    });

    // 2. Get the Extension ID
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extensionId = sw.url().split('/')[2];
    console.log(`🔍 Extension Loaded. ID: ${extensionId}`);

    // 3. Open the Target Application (Replace with your staging URL)
    const TARGET_URL = process.env.TARGET_URL || 'https://opensource-demo.orangehrmlive.com/';
    const page = await context.newPage();
    await page.goto(TARGET_URL);
    console.log(`🌐 Navigated to ${TARGET_URL}`);

    // 4. Start Recording via the Service Worker
    await sw.evaluate(async () => {
        const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
        const tabId = tabs[0].id;
        return new Promise(r => chrome.runtime.sendMessage({
            type: 'START_RECORDING',
            name: 'CI_Automated_Run',
            tabId: tabId,
            throttle: 'cpu4x', // Simulate slow device
            skipReload: true   // Don't break Playwright context
        }, r));
    });
    console.log('🔴 Recording Started (4x CPU Throttle)');

    // Wait for the 2-second settle window to pass
    await page.waitForTimeout(2500);

    // 5. THE USER JOURNEY (Modify this part for your app)
    console.log('🤖 Simulating User Journey...');
    
    // Example: OrangeHRM Login Flow
    await page.fill('input[name="username"]', 'Admin');
    await page.fill('input[name="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000); // Wait for Dashboard to load
    
    // Example: Navigate to a specific module
    // await page.click('text="Leave"');
    // await page.waitForTimeout(2000);

    // 6. Stop Recording
    await sw.evaluate(() => {
        return new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, r));
    });
    console.log('⏹️ Recording Stopped');

    // 7. Generate Report & Download ZIP
    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/src/panel.html`);

    // Wait for the report to be saved and download button to appear
    await panelPage.waitForSelector('#downloadZipBtn', { state: 'visible', timeout: 15000 });
    
    const downloadPromise = panelPage.waitForEvent('download');
    await panelPage.click('#downloadZipBtn');
    const download = await downloadPromise;
    
    const zipPath = path.join(__dirname, 'ci-report.zip');
    await download.saveAs(zipPath);
    console.log(`📦 Report Downloaded to ${zipPath}`);

    // 8. Extract and Analyze Health Score
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(path.join(__dirname, 'extracted'), true);
    const reportHtml = fs.readFileSync(path.join(__dirname, 'extracted', 'report.html'), 'utf8');
    
    // Extract the score from the HTML
    const scoreMatch = reportHtml.match(/<div class="rpt-ring-num">(\d+|—)<\/div>/);
    const score = scoreMatch ? scoreMatch[1] : 'Unknown';
    
    console.log(`\n========================================`);
    console.log(`📊 PERF-LENS HEALTH SCORE: ${score}/100`);
    console.log(`========================================\n`);

    // Note: We print a GitHub Action warning, but we DO NOT fail the build (exit 1)
    if (score !== 'Unknown' && Number(score) < 50) {
        console.log(`::warning::Performance Health Score is critically low (${score}/100)! Check the uploaded artifact.`);
    }

    await context.close();
})();