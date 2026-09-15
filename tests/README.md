# Local validation

The browser validation uses development packages installed outside this repository. Create the isolated tools directory, then install them:

```powershell
New-Item -ItemType Directory -Force ..\.pixel-tv-tools | Out-Null
cd ..\.pixel-tv-tools
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install --save-dev acorn playwright
```

Run the browser diagnostic validation with an installed Chrome or Edge executable:

```powershell
cd ..\pixel-tv-mirror
$env:NODE_PATH = (Resolve-Path ..\.pixel-tv-tools\node_modules)
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests\diagnostic-validation.cjs
```

It serves `tv-test.html` at an ephemeral `127.0.0.1` port unless `TEST_URL` is set, runs the real local WebRTC check twice, tests failure-safe probes, and asserts that no browser request leaves that local origin. It saves `diagnostic-validation-1280x720.png` and the full-page `diagnostic-validation.png` under `..\.pixel-tv-tools`.

Run the browser suite with access to the host network stack. A sandbox that blocks local UDP can make the real peer/data-channel check time out even when the page is working correctly.

Run the RTC mock tests with Node alone:

```powershell
node tests\rtc-self-test.cjs
```
