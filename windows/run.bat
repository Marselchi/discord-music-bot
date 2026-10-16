@echo off
cd /d "%~dp0"

:loop
if exist bot-server-update.exe (
  move /y bot-server-update.exe bot-server.exe >nul 2>&1
)

bot-server.exe
set EXITCODE=%errorlevel%

if exist bot-server-update.exe (
  echo.
  echo [launcher] Applying downloaded update...
  move /y bot-server-update.exe bot-server.exe >nul 2>&1
  echo [launcher] Restarting bot-server...
  goto loop
)

if %EXITCODE% neq 0 (
  echo.
  echo The bot exited with an error - see above.
  pause
)
