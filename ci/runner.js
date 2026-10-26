const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

(async () => {
    console.log('🚀 Starting Perf-Lens CI Runner...');
    
    const pathToExtension = path.resolve(__dirname, '..'); 
    const userDataDir = '/tmp/perf-lens-user-data';
    const zipPath = path.join(__dirname, 'ci-report.zip');

    // Ensure the ci directory exists
    if (!fs.existsSync(__dirname)) {
        fs.mkdirSync(__dirname, { recursive: true });
    }

    let context;
    try {
        console.log('Launching Browser...');
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${pathToExtension}`,
                `--load-extension=${pathToExtension}`,
                `--no-sandbox`,
                `--disable-setuid-sandbox`
            ],
            timeout: 60000
        });

        console.log('Waiting for extension service worker...');
        let sw;
        try {
            sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
        } catch (e) {
            const workers = context.serviceWorkers();
            if (workers.length > 0) sw = workers[0];
            else throw new Error('Extension service worker failed to start. Cannot continue.');
        }

        const extensionId = sw.url().split('/')[2];
        console.log(`🔍 Extension Loaded. ID: ${extensionId}`);

        const TARGET_URL = process.env.TARGET_URL || 'https://opensource-demo.orangehrmlive.com/';
        const page = await context.newPage();
        
        console.log(`🌐 Navigating to ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

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

        await page.waitForTimeout(2500);

        console.log('🤖 Simulating User Journey...');
        try {
            await page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await page.fill('input[name="username"]', 'Admin');
            await page.fill('input[name="password"]', 'admin123');
            await page.waitForSelector('button[type="submit"]', { timeout: 10000 });
            await page.click('button[type="submit"]');
            console.log('Login successful. Waiting for dashboard...');
            await page.waitForTimeout(5000); 
        } catch (err) {
            console.warn('⚠️ User Journey failed (Element not found). Stopping recording anyway to get report...');
        }

        console.log('⏹️ Stopping Recording...');
        await sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, r)));

        console.log('📦 Generating Report...');
        const panelPage = await context.newPage();
        
        console.log('Waiting for panel to load...');
        await panelPage.goto(`chrome-extension://${extensionId}/src/panel.html`);
        
        console.log('Waiting for Download button to appear...');
        await panelPage.waitForSelector('#downloadZipBtn', { state: 'visible', timeout: 30000 });
        
        console.log('Clicking Download...');
        const downloadPromise = panelPage.waitForEvent('download', { timeout: 15000 });
        await panelPage.click('#downloadZipBtn');
        
        console.log('Waiting for download to finish...');
        const download = await downloadPromise;
        await download.saveAs(zipPath);
        console.log(`✅ Report Downloaded to ${zipPath}`);

        // Parse Score
        if (fs.existsSync(zipPath)) {
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(path.join(__dirname, 'extracted'), true);
            const reportHtml = fs.readFileSync(path.join(__dirname, 'extracted', 'report.html'), 'utf8');
            const scoreMatch = reportHtml.match(/<div class="rpt-ring-num">(\d+|—)<\/div>/);
            if (scoreMatch) {
                console.log(`\n========================================`);
                console.log(`📊 PERF-LENS HEALTH SCORE: ${scoreMatch[1]}/100`);
                console.log(`========================================\n`);
            }
        }

    } catch (error) {
        console.error('\n❌❌❌ FATAL ERROR IN RUNNER.JS ❌❌❌\n');
        console.error(error);
        process.exitCode = 1; // Force failure so you can see the error
    } finally {
        if (context) {
            console.log('Closing browser context...');
            await context.close();
        }
    }
})();