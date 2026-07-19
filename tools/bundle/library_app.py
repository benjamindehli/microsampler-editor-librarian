#!/usr/bin/env python3
"""Entry point for the BUNDLED 'microSAMPLER Library' app (PyInstaller).

Wraps bridge.py --library for a double-clickable, no-terminal experience:
  * backups go to a per-user data dir (not inside the app bundle, which is
    read-only / replaced on update)
  * the bundled web-editor/ is served via MSMPL_WEB_ROOT
  * MSMPL_ALLOW_SHUTDOWN=1 enables POST /api/shutdown, so the web UI shows a
    QUIT button (there is no terminal to Ctrl+C)
  * once the server answers, the UI opens in a Chromium app-mode window when
    available (own window, app-like), else the default browser; if a library
    bridge is ALREADY running on the port, just open it
  * stdout/stderr go to <data dir>/library.log when frozen (windowed apps may
    have no usable stdio)

Build: pyinstaller tools/bundle/library.spec  (see .github/workflows/package.yml)
Plain `python3 tools/bundle/library_app.py` also works for a quick local run.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

PORT = 8766          # library mode's own port (device bridge uses 8765)

# Chromium-family browsers that support `--app=URL` (own window, no tabs/URL
# bar — feels like an app, keeps every browser feature incl. downloads)
CHROMIUM_MACOS = ('Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium')
CHROMIUM_LINUX = ('google-chrome', 'microsoft-edge', 'brave-browser',
                  'chromium', 'chromium-browser')


def open_ui(url):
    """Open the UI in a Chromium app-mode window when one is installed (the
    same trick the .command launcher uses); otherwise the default browser."""
    if os.environ.get('MSMPL_NO_OPEN') == '1':
        return                       # CI smoke tests run headless
    if sys.platform == 'darwin':
        for app in CHROMIUM_MACOS:
            if subprocess.call(['open', '-na', app, '--args', '--app=' + url],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL) == 0:
                return
    elif sys.platform.startswith('linux'):
        for exe in CHROMIUM_LINUX:
            path = shutil.which(exe)
            if path:
                subprocess.Popen([path, '--app=' + url],
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
                return
    webbrowser.open(url)


def resource_root():
    """Where bundled data files live: PyInstaller extracts datas next to the
    binary (_MEIPASS); unfrozen = the repo root (two levels up from here)."""
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', '..'))


def user_data_dir():
    """Vendor-namespaced (…/DehliMusikk/microSAMPLER Library) so it can never
    collide with another app's folder, and future Dehli Musikk apps share one
    tidy parent."""
    if sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support')
    elif os.name == 'nt':
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
    return os.path.join(base, 'DehliMusikk', 'microSAMPLER Library')


def library_bridge_at(port):
    """True if the thing answering on `port` is OUR library bridge."""
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/status' % port,
                                    timeout=1.5) as r:
            return bool(json.loads(r.read().decode()).get('library'))
    except Exception:
        return False


def port_free(port):
    try:
        s = socket.socket()
        # SO_REUSEADDR so this pre-check matches the actual server (HTTPServer
        # sets allow_reuse_address): without it, a just-killed bridge's socket
        # in TIME_WAIT makes this falsely report "busy", which sent the child
        # to a random port the shell can't find → "Library not responding".
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', port))
        s.close()
        return True
    except OSError:
        return False


def open_when_up(url, port):
    """Poll until the server accepts connections, then open the UI."""
    for _ in range(240):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.5).close()
            open_ui(url)
            return
        except OSError:
            time.sleep(0.25)


def main():
    data = user_data_dir()
    os.makedirs(os.path.join(data, 'backups'), exist_ok=True)

    if getattr(sys, 'frozen', False):
        # windowed bundles may have no stdio — keep a log for troubleshooting
        log_path = os.path.join(data, 'library.log')
        try:
            if os.path.getsize(log_path) > 5 * 1024 * 1024:
                os.replace(log_path, log_path + '.old')   # keep one generation
        except OSError:
            pass
        log = open(log_path, 'a', buffering=1)
        sys.stdout = sys.stderr = log
        print('--- microSAMPLER Library started', time.strftime('%Y-%m-%d %H:%M:%S'))

    # under the Swift shell (macOS .app) the shell owns the browser + only knows
    # PORT, so the child must NOT wander to a random port — bind PORT or fail.
    shell_mode = os.environ.get('MSMPL_NO_OPEN') == '1'
    port = PORT
    if not port_free(port):
        if library_bridge_at(port):     # already running → just open its UI
            open_ui('http://localhost:%d' % port)
            return 0
        if not shell_mode:              # standalone: 8766 taken → any free port
            s = socket.socket()
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
            s.close()

    root = resource_root()
    os.environ['MSMPL_WEB_ROOT'] = os.path.join(root, 'web-editor')
    os.environ.setdefault('MSMPL_BACKUP_DIR', os.path.join(data, 'backups'))
    os.environ['MSMPL_ALLOW_SHUTDOWN'] = '1'
    # exit ~2 min after the last UI window closes — the app must not linger as
    # an invisible background process (ghost processes also confuse macOS
    # LaunchServices into "app is not open anymore" states)
    os.environ.setdefault('MSMPL_IDLE_EXIT', '120')

    threading.Thread(target=open_when_up,
                     args=('http://localhost:%d' % port, port),
                     daemon=True).start()

    # hand over to the bridge exactly as the CLI would run it (env is read at
    # import time, so import AFTER the environment is set)
    sys.path.insert(0, os.path.join(root, 'native-tools'))
    sys.argv = ['bridge.py', '--library', '--port', str(port)]
    import bridge
    return bridge.main()


if __name__ == '__main__':
    sys.exit(main())
