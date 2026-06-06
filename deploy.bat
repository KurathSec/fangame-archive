@echo off
echo ==============================================
echo       DEPLOYING TO CLOUDFLARE PAGES
echo ==============================================
echo [Step 0] Downloading latest database from Cloudflare R2...
py pipelines/sync_db_r2.py download
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to download database from R2! Deployment aborted.
    pause
    exit /b %ERRORLEVEL%
)
py pipelines/build_github_pages.py
npx wrangler pages deploy github_pages_dist --project-name fangame-archive
echo ==============================================
echo       DEPLOYMENT RUN COMPLETE!
echo ==============================================
pause
