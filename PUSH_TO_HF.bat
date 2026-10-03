@echo off
color 0A
echo ========================================================
echo     Pushing directly to Hugging Face Space
echo ========================================================
echo.
echo Please go to: https://huggingface.co/settings/tokens
echo Create a new Access Token (Make sure to select "WRITE" permissions)
echo.
set /p hfToken="Paste your Hugging Face Access Token here: "

echo.
echo [*] Pushing code to Hugging Face...
git push -f https://TheUzair:%hfToken%@huggingface.co/spaces/TheUzair/youtube-checker main

echo.
echo ========================================================
echo Done! Check your Hugging Face Space page, it should be building now!
echo ========================================================
pause
