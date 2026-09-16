@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
echo Starting local TV video test server...
echo Sender URL will be shown below. Keep this window open while testing.
"%NODE_EXE%" "%~dp0video-server.cjs"
endlocal
