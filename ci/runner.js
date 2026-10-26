const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

(async () => {
    console.log('🚀 Starting Perf-Lens CI Runner...');
    
    const pathToExtension = path.resolve(__dirname, '..'); 
    const userDataDir = '/tmp/perf-lens-user-data';
    const zipPath = path.join(__dirname, 'ci-report.zip');

    if (!fs.existsSync(__dirname)) fs.mkdirSync(__dirname, { recursive: true });

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
            acceptDownloads: true,
            timeout: 60000
        });

        console.log('Waiting for extension service worker...');
        let sw;
        try {
            sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
        } catch (e) {
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

        console.log('🔴 Starting Recording...');
        await sw.evaluate(async (throttle) => {
            const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
            return new Promise(r => chrome.runtime.sendMessage({
                type: 'START_RECORDING', name: 'CI_Run', tabId: tabs[0].id, throttle: throttle, skipReload: true
            }, r));
        }, process.env.PERF_THROTTLE || 'none');

        await page.waitForTimeout(2500);

        console.log('🤖 Simulating User Journey...');
        try {
            await page.waitForSelector('input[name="username"]', { timeout: 10000 });
            await page.fill('input[name="username"]', 'Admin');
            await page.fill('input[name="password"]', 'admin123');
            await page.click('button[type="submit"]');
            await page.waitForTimeout(5000); 
        } catch (err) {
            console.warn('⚠️ User Journey failed. Stopping recording anyway...');
        }

        console.log('⏹️ Stopping Recording...');
        await sw.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, r)));

        console.log('⏳ Waiting 4 seconds for Service Worker to save the JSON data...');
        await new Promise(r => setTimeout(r, 4000));

        // ==============================================================
        // NEW BULLETPROOF EXTRACTION: Get JSON directly from Storage, 
        // generate HTML via the extension's own script, and save to disk.
        // ==============================================================
        
        console.log('📦 Extracting raw JSON from chrome.storage...');
        const storageData = await sw.evaluate(() => new Promise(r => chrome.storage.local.get('lastReport', r)));
        
        if (!storageData || !storageData.lastReport) {
            throw new Error("Could not find lastReport in chrome.storage.");
        }
        const report = storageData.lastReport;

        console.log('🎨 Opening Panel to generate HTML via reportTheme.js...');
        const panelPage = await context.newPage();
        await panelPage.goto(`chrome-extension://${extensionId}/src/panel.html`);
        
        // Use the extension's own code to generate the HTML
        const htmlContent = await panelPage.evaluate((rep) => {
            let health = null;
            if (window.PerfHealth) health = window.PerfHealth.computeHealth(rep);
            if (window.ReportTheme) return window.ReportTheme.buildSelfContainedHTML(rep, health);
            return null;
        }, report);

        if (!htmlContent) throw new Error("Failed to generate HTML via reportTheme.js.");

        // Write the HTML to disk
        const htmlPath = path.join(__dirname, 'report.html');
        fs.writeFileSync(htmlPath, htmlContent, 'utf8');
        console.log(`✅ HTML Report generated at ${htmlPath}`);

        // Zip it up using Node.js (AdmZip)
        const zip = new AdmZip();
        zip.addLocalFile(htmlPath);
        zip.writeZip(zipPath);
        console.log(`✅ ZIP created at ${zipPath}`);

        // Log the Health Score
        const scoreMatch = htmlContent.match(/<div class="rpt-ring-num">(\d+|—)<\/div>/);
        if (scoreMatch) {
            console.log(`\n========================================`);
            console.log(`📊 PERF-LENS HEALTH SCORE: ${scoreMatch[1]}/100`);
            console.log(`========================================\n`);
        }

    } catch (error) {
        console.error('\n❌❌❌ FATAL ERROR IN RUNNER.JS ❌❌❌\n');
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (context) await context.close();
    }
})();