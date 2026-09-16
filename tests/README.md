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

## Stage 2 local-video validation

The isolated signaling-server and RTC unit tests use Node built-ins only:

```powershell
node tests\video-server-test.cjs
node tests\video-rtc-unit.cjs
```

The real-browser test needs the same isolated `NODE_PATH` setup and an installed Chrome or Edge executable. It defaults to a short run; set 120 seconds for a sustained local check:

```powershell
$env:NODE_PATH = (Resolve-Path ..\.pixel-tv-tools\node_modules)
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:VIDEO_TEST_SECONDS = '120'
node tests\video-browser.cjs
```

Set `TV_TEST_HOST` to the test computer LAN IPv4 address to load the receiver over ordinary HTTP rather than trusted localhost. Both browser roles and the temporary server still run on this computer:

```powershell
$env:TV_TEST_HOST = '192.168.1.77'
node tests\video-browser.cjs
```

## Optional LAN firewall helper

`Enable-Video-Test-LAN.ps1` is only for a temporary isolated video-test server that Windows Firewall blocks on the local network. It requires an elevated PowerShell session and a running `video-server.cjs` PID. The helper creates one inbound TCP rule limited to the supplied local IPv4 address, port, Node executable, and `LocalSubnet`; it does not change firewall profiles or existing rules. It watches that exact process for up to four hours, then removes the exact rule it created when the server exits, its PID is replaced, or the limit is reached. Launch the helper explicitly with administrator approval, supplying the verified server PID and local address; do not edit unrelated firewall rules.
