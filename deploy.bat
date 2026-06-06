@echo off
echo ==============================================
echo       DEPLOYING TO CLOUDFLARE PAGES
echo ==============================================
py pipelines/build_github_pages.py
npx wrangler pages deploy github_pages_dist --project-name fangame-archive
echo ==============================================
echo       DEPLOYMENT RUN COMPLETE!
echo ==============================================
pause
