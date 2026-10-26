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

        console.log('⏳ Waiting 4 seconds for Service Worker to build the report...');
        await new Promise(r => setTimeout(r, 4000));

        console.log('📦 Opening Panel to extract ZIP...');
        const panelPage = await context.newPage();
        
        // THIS IS THE FIX: Intercept the Blob URL creation
        await panelPage.addInitScript(() => {
            window.__PERF_LENS_ZIP_BASE64__ = null;
            const originalCreateObjectURL = URL.createObjectURL;
            URL.createObjectURL = function(blob) {
                const reader = new FileReader();
                reader.onload = function() {
                    if (reader.result) {
                        window.__PERF_LENS_ZIP_BASE64__ = reader.result.split(',')[1];
                    }
                };
                reader.readAsDataURL(blob);
                return originalCreateObjectURL.call(URL, blob);
            };
        });

        await panelPage.goto(`chrome-extension://${extensionId}/src/panel.html`);
        
        console.log('🔓 Forcing download button to appear...');
        await panelPage.evaluate(() => {
            const btn = document.getElementById('downloadZipBtn');
            if (btn) btn.classList.remove('hidden');
        });
        
        console.log('Clicking Download and intercepting ZIP...');
        await panelPage.click('#downloadZipBtn');

        console.log('Waiting for ZIP data in memory...');
        await panelPage.waitForFunction(() => window.__PERF_LENS_ZIP_BASE64__ !== null, { timeout: 30000 });
        
        const base64Data = await panelPage.evaluate(() => window.__PERF_LENS_ZIP_BASE64__);
        
        if (!base64Data) throw new Error("No ZIP data captured.");

        fs.writeFileSync(zipPath, Buffer.from(base64Data, 'base64'));
        console.log(`✅ Report extracted and saved to ${zipPath}`);

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
        process.exitCode = 1;
    } finally {
        if (context) await context.close();
    }
})();