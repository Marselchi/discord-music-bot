@echo off
cd /d "%~dp0"
bot-server.exe
if errorlevel 1 (
  echo.
  echo The bot exited with an error - see above.
  pause
)
