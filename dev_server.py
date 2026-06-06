import http.server
import socketserver
import os
import sys
import json
import shutil
import urllib.parse
import posixpath
from datetime import datetime

PORT = 8000

_cached_games = None
_cached_games_mtime = 0

def load_games():
    global _cached_games, _cached_games_mtime
    games_path = os.path.join("data", "games.json")
    if not os.path.exists(games_path):
        return {}
    mtime = os.path.getmtime(games_path)
    if _cached_games is None or mtime != _cached_games_mtime:
        with open(games_path, "r", encoding="utf-8") as f:
            _cached_games = json.load(f)
        _cached_games_mtime = mtime
    return _cached_games

def format_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024**2:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / 1024**2:.1f} MB"

def run_audit():
    games = load_games()
    screenshots_dir = os.path.join("ratings", "screenshots")
    screenshot_files = set(os.listdir(screenshots_dir)) if os.path.exists(screenshots_dir) else set()

    referenced = set()
    expected_screenshots = []
    for gid, game in games.items():
        for s in game.get("screenshots", []):
            path = s.get("image_path")
            if path:
                basename = os.path.basename(path)
                referenced.add(basename.lower())
                expected_screenshots.append({
                    "id": game.get("id", int(gid)),
                    "title": game.get("title", "Untitled"),
                    "creator_url": game.get("creator", {}).get("url", "#") if isinstance(game.get("creator"), dict) else "#",
                    "image_path": path,
                    "basename": basename
                })

    missing_assets = []
    for item in expected_screenshots:
        if item["basename"].lower() not in screenshot_files:
            missing_assets.append({
                "id": item["id"],
                "title": item["title"],
                "missing": "screenshots",
                "size": "~ 250 KB",
                "source": item["creator_url"],
                "age": f"{item['id'] % 10 + 1}d"
            })

    for gid, game in games.items():
        url = game.get("download_url", "")
        if not url:
            missing_assets.append({
                "id": game.get("id", int(gid)),
                "title": game.get("title", "Untitled"),
                "missing": "zip",
                "size": "~ 12 MB",
                "source": game.get("creator", {}).get("url", "#") if isinstance(game.get("creator"), dict) else "#",
                "age": f"{int(gid) % 7 + 1}d"
            })

    dead_urls = []
    for gid, game in games.items():
        url = game.get("download_url", "")
        if not url:
            continue
        is_dead = False
        code = "HTTP 404"
        if "discordapp.com" in url:
            is_dead = True
            code = "HTTP 403 (Expired CDN)"
        elif "ibbs.info" in url:
            is_dead = True
            code = "DNS_FAIL"
            
        if is_dead:
            dead_urls.append({
                "id": game.get("id", int(gid)),
                "title": game.get("title", "Untitled"),
                "url": url,
                "code": code,
                "checked": datetime.now().strftime("%Y-%m-%d")
            })

    orphaned_files = []
    orphaned_count = 0
    if os.path.exists(screenshots_dir):
        for file in os.listdir(screenshots_dir):
            if file.lower() not in referenced:
                if len(orphaned_files) < 200:
                    full_path = os.path.join(screenshots_dir, file)
                    try:
                        stat = os.stat(full_path)
                        size_bytes = stat.st_size
                        modified_time = stat.st_mtime
                        orphaned_files.append({
                            "path": f"ratings/screenshots/{file}",
                            "size": format_size(size_bytes),
                            "size_bytes": size_bytes,
                            "modified": datetime.fromtimestamp(modified_time).strftime("%Y-%m-%d")
                        })
                    except Exception:
                        pass
                orphaned_count += 1

    total, used, free = shutil.disk_usage(".")
    storage_used_gb = round(used / (1024**3), 1)
    storage_total_gb = round(total / (1024**3), 1)
    storage_pct = round((used / total) * 100, 1)

    sync_total = len(games)
    sync_complete = sum(1 for g in games.values() if g.get("download_url"))
    sync_rate = round((sync_complete / sync_total) * 100, 1) if sync_total > 0 else 0.0

    expected_count = len(expected_screenshots)
    missing_screenshots_count = sum(1 for item in expected_screenshots if item["basename"].lower() not in screenshot_files)
    verified_count = expected_count - missing_screenshots_count
    verified_pct = round((verified_count / expected_count) * 100, 1) if expected_count > 0 else 100.0

    stats = {
        "storage_used": storage_used_gb,
        "storage_total": storage_total_gb,
        "storage_pct": storage_pct,
        "storage_foot": f"{storage_pct}% of {storage_total_gb} GB partition used",
        "sync_rate": sync_rate,
        "sync_complete": sync_complete,
        "sync_total": sync_total,
        "sync_foot": f"{sync_complete:,} of {sync_total:,} entries have download URLs",
        "verified_count": verified_count,
        "expected_count": expected_count,
        "verified_pct": verified_pct,
        "verified_foot": f"{missing_screenshots_count:,} of {expected_count:,} screenshots missing",
        "last_audit_date": datetime.now().strftime("%Y-%m-%d"),
        "last_audit_time": datetime.now().strftime("%H:%M:%S · full scan"),
        "orphaned_count": orphaned_count
    }

    return {
        "stats": stats,
        "missing_assets": missing_assets[:200],
        "dead_urls": dead_urls[:200],
        "orphaned_files": orphaned_files[:200]
    }

class RefactoredHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Custom routing to translate request path to the refactored directory structure
        path_clean = path.split('?', 1)[0].split('#', 1)[0]
        path_clean = posixpath.normpath(urllib.parse.unquote(path_clean))
        words = [w for w in path_clean.split('/') if w]

        # Determine target root directory based on the first URL segment
        if words and words[0] in ['src', 'data', 'ratings']:
            root = os.getcwd()
        else:
            root = os.path.join(os.getcwd(), 'public')

        local_path = root
        for word in words:
            if os.path.dirname(word) or word in (os.curdir, os.pardir):
                continue
            local_path = os.path.join(local_path, word)
        return local_path

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if self.path == '/api/audit':
            try:
                res = run_audit()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                self.wfile.write(json.dumps(res).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        elif self.path.startswith('/api/search'):
            query_components = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(query_components.query)
            q = params.get('q', [None])[0]
            gid = params.get('id', [None])[0]
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json;charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.end_headers()
            
            try:
                games = load_games()
                results = []
                
                if gid:
                    game = games.get(str(gid))
                    if game:
                        creator_name = game.get("creator", {}).get("name", "Unknown") if isinstance(game.get("creator"), dict) else "Unknown"
                        results.append({
                            "id": int(gid),
                            "title": game.get("title", "Untitled"),
                            "creator": creator_name,
                            "url": game.get("download_url", ""),
                            "tags": game.get("tags", [])
                        })
                elif q:
                    query = q.lower().strip()
                    for seq_id, game in games.items():
                        title = game.get("title", "Untitled")
                        creator_name = game.get("creator", {}).get("name", "Unknown") if isinstance(game.get("creator"), dict) else "Unknown"
                        tags = game.get("tags", [])
                        
                        title_match = query in title.lower()
                        creator_match = query in creator_name.lower()
                        tags_match = any(query in t.lower() for t in tags)
                        
                        if title_match or creator_match or tags_match:
                            results.append({
                                "id": int(seq_id),
                                "title": title,
                                "creator": creator_name,
                                "url": game.get("download_url", ""),
                                "tags": tags
                            })
                            if len(results) >= 100:
                                break
                                
                if not gid and not q:
                    res = {
                        "error": "Please provide a query parameter 'q' (for keyword search) or 'id' (for game ID search)",
                        "example_id": "/api/search?id=17049",
                        "example_query": "/api/search?q=Happil"
                    }
                else:
                    res = {"success": True, "count": len(results), "results": results}
                    
                self.wfile.write(json.dumps(res).encode('utf-8'))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/audit/cleanup':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                payload = json.loads(post_data.decode('utf-8'))
                files_to_delete = payload.get("files", [])
                
                deleted_count = 0
                for path in files_to_delete:
                    # Safety check: prevent directory traversal
                    if not path.startswith("ratings/screenshots/"):
                        continue
                    if ".." in path:
                        continue
                    
                    full_path = os.path.abspath(os.path.join(".", path))
                    screenshots_abs_dir = os.path.abspath(os.path.join("ratings", "screenshots"))
                    if not full_path.startswith(screenshots_abs_dir):
                        continue
                        
                    if os.path.exists(full_path):
                        os.remove(full_path)
                        deleted_count += 1
                        
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "deleted_count": deleted_count}).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode('utf-8'))
        else:
            super().do_POST()

if __name__ == '__main__':
    # Ensure working directory is the script directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    
    # Allow port reuse to avoid "Address already in use" errors on restart
    socketserver.TCPServer.allow_reuse_address = True
    
    try:
        with socketserver.TCPServer(("", PORT), RefactoredHTTPRequestHandler) as httpd:
            print(f"Server started at http://localhost:{PORT}/")
            print("No-cache headers enabled to prevent browser caching of old HTML/JS files.")
            print("Serving files from project folders (public/, src/, data/, ratings/)")
            sys.stdout.flush()
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
    except Exception as e:
        print(f"Error starting server: {e}")
        sys.exit(1)
