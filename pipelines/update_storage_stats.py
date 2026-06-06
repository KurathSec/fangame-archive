import os
import sys
import json
import re

# Set UTF-8 encoding for console output on Windows
sys.stdout.reconfigure(encoding='utf-8')

GAMES_PATH = "data/games.json"
COMPONENTS_PATH = "src/components.jsx"
BUILD_SCRIPT_PATH = "pipelines/build_github_pages.py"

def calculate_storage():
    print("Reading games.json...")
    if not os.path.exists(GAMES_PATH):
        print(f"Error: games.json not found at {GAMES_PATH}")
        sys.exit(1)
        
    with open(GAMES_PATH, "r", encoding="utf-8") as f:
        games = json.load(f)
        
    total_bytes = 0
    direct_count = 0
    for gid, game in games.items():
        url = game.get("download_url", "")
        if url:
            if "file.fangame-archive.com/" in url or "r2.dev/" in url:
                total_bytes += game.get("file_size", 0)
                direct_count += 1
                
    total_gb = total_bytes / (1024 * 1024 * 1024)
    print(f"Found {direct_count} direct link games.")
    print(f"Calculated total size: {total_bytes} bytes ({total_gb:.2f} GB)")
    return total_bytes, total_gb

def update_components(total_gb):
    print(f"Updating {COMPONENTS_PATH}...")
    if not os.path.exists(COMPONENTS_PATH):
        print(f"Error: components.jsx not found at {COMPONENTS_PATH}")
        sys.exit(1)
        
    with open(COMPONENTS_PATH, "r", encoding="utf-8") as f:
        content = f.read()
        
    # Replace Storage stat line
    old_stat = r'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">371.22 GB</b></div>'
    new_stat = f'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">{total_gb:.2f} GB</b></div>'
    
    if old_stat in content:
        content = content.replace(old_stat, new_stat)
        print("  - Updated Storage stat display line successfully.")
    else:
        # Fallback regex if it was already updated or is different
        content, count = re.subn(
            r'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">[\d\.]+? GB</b></div>',
            new_stat,
            content
        )
        if count > 0:
            print(f"  - Updated {count} Storage stat display lines via regex.")
        else:
            print("  - Warning: Could not find Storage display stat in components.jsx!")
            
    # Replace the description "350GB+" text
    rounded_gb = int(round(total_gb))
    old_desc = "350GB+"
    new_desc = f"{rounded_gb}GB+"
    if old_desc in content:
        content = content.replace(old_desc, new_desc)
        print(f"  - Updated description text from '{old_desc}' to '{new_desc}' successfully.")
    else:
        content, count = re.subn(
            r'\d+?GB\+',
            new_desc,
            content
        )
        if count > 0:
            print(f"  - Updated {count} description text instances via regex.")
        else:
            print("  - Warning: Could not find description '350GB+' text in components.jsx!")
            
    with open(COMPONENTS_PATH, "w", encoding="utf-8") as f:
        f.write(content)

def update_build_script(total_gb):
    print(f"Updating {BUILD_SCRIPT_PATH}...")
    if not os.path.exists(BUILD_SCRIPT_PATH):
        print(f"Error: build_github_pages.py not found at {BUILD_SCRIPT_PATH}")
        sys.exit(1)
        
    with open(BUILD_SCRIPT_PATH, "r", encoding="utf-8") as f:
        content = f.read()
        
    # Replace Storage stat line in build script compiler config
    old_stat = r'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">371.22 GB</b></div>'
    new_stat = f'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">{total_gb:.2f} GB</b></div>'
    
    if old_stat in content:
        content = content.replace(old_stat, new_stat)
        print("  - Updated build_github_pages.py storage compiler line successfully.")
    else:
        # Fallback regex
        content, count = re.subn(
            r'<div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">[\d\.]+? GB</b></div>',
            new_stat,
            content
        )
        if count > 0:
            print(f"  - Updated {count} Storage stat builder lines via regex.")
        else:
            print("  - Warning: Could not find Storage stat in build_github_pages.py!")
            
    with open(BUILD_SCRIPT_PATH, "w", encoding="utf-8") as f:
        f.write(content)

def main():
    print("=" * 60)
    print("      DYNAMIC STORAGE STATS CALCULATOR & SYNCER")
    print("=" * 60)
    
    # 1. Calculate size
    total_bytes, total_gb = calculate_storage()
    
    # 2. Update files
    update_components(total_gb)
    update_build_script(total_gb)
    
    print("\nSUCCESS!")
    print(f"Storage stat has been updated to: {total_gb:.2f} GB across components and compilers.")
    print("=" * 60)

if __name__ == "__main__":
    main()
