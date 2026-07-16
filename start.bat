@echo off
REM Arabtec Recruitment Hub - one-click launcher (Windows). Double-click to run.
setlocal
cd /d "%~dp0backend"

echo.
echo   Arabtec Recruitment Hub - starting up...
echo   ------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo   X Node.js is not installed. Install Node 22.5+ from https://nodejs.org and re-run.
  pause
  exit /b 1
)
echo   - Node detected

if not exist node_modules (
  echo   - Installing dependencies ^(first run only^)...
  call npm install --silent
)

if not exist prisma\dev.db (
  echo   - Setting up the database with demo data...
  call npm run seed >nul
)

set PORT=4000
set URL=http://localhost:%PORT%

echo   - Launching at %URL%
echo   ------------------------------------------------
echo   Demo logins:
echo     Admin     admin@arabtec.com     / Admin@12345
echo     Recruiter recruiter@arabtec.com / Arabtec@123
echo   ------------------------------------------------
echo   Keep this window open while you use the app. Close it to stop.
echo.

start "" "%URL%"
call npm start
