@echo off
color 0A
echo ========================================================
echo        YouTube Checker - Auto GitHub Sync
echo ========================================================
echo.

:: Check if git is initialized
if not exist .git (
    echo [!] Git is not initialized! Initializing now...
    git init
    git branch -M main
)

:: Check if origin exists
git remote -v | findstr "origin" >nul
if errorlevel 1 (
    echo [!] GitHub remote not linked.
    set /p repoUrl="Enter your GitHub Repository URL (e.g., https://github.com/user/repo.git): "
    git remote add origin %repoUrl%
    git branch -M main
    echo.
)

:: Stage all files (respecting .gitignore)
echo [*] Staging files...
git add .

:: Prompt for commit message
set commitMsg=
set /p commitMsg="[*] Enter commit message (Leave blank for auto-timestamp): "

if "%commitMsg%"=="" (
    set commitMsg=Auto-update: %date% %time%
)

:: Commit and Push
echo.
echo [*] Committing...
git commit -m "%commitMsg%"

echo.
echo [*] Pushing to remote repository...
git push -u origin main

echo.
echo ========================================================
echo   Done! Your app is synced to the cloud.
echo ========================================================
pause
