@echo off
echo ==============================================
echo       STARTING ENTIRE SYNCHRONIZATION WORKFLOW
echo ==============================================
echo.
echo [Step 0] Downloading latest databases from Cloudflare R2...
py pipelines/sync_db_r2.py download
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Failed to download database from R2! Deployment aborted.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [Step 1] Scraping Delicious Fruit, ingesting new games,
echo          finding links on Wiki, downloading supported
echo          netdisks, uploading to Cloudflare R2, and
echo          building the static application...
echo.
py pipelines/scrape_and_migrate_new_games.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Synchronization and building failed! Deployment aborted.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================
echo       INGESTING LOCAL GAME FILES TO R2
echo ==============================================
echo.
echo [Step 1.2] Checking local game directory and syncing to R2...
py pipelines/ingest_local_folder_games.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Local game ingestion encountered errors! Continuing anyway.
)

echo.
echo ==============================================
echo       SYNCING SCREENSHOTS TO CLOUDFLARE R2
echo ==============================================
echo.
echo [Step 1.5] Performing incremental check and syncing screenshots...
py pipelines/sync_screenshots_to_r2.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Screenshot sync encountered errors! Continuing deployment anyway.
)

echo.
echo ==============================================
echo       UPLOADING UPDATED DATABASES TO R2
echo ==============================================
echo.
echo [Step 1.8] Saving updated databases back to Cloudflare R2...
py pipelines/sync_db_r2.py upload
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Database upload to R2 failed!
)

echo.
echo ==============================================
echo       DEPLOYING TO CLOUDFLARE PAGES
echo ==============================================
echo.
echo [Step 2] Pushing production distribution build to Cloudflare Pages...
npx wrangler pages deploy github_pages_dist --project-name fangame-archive
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Cloudflare Pages deployment failed!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================
echo       ALL WORKFLOW ACTIONS COMPLETED SUCCESSFULLY!
echo ==============================================
pause
