#!/usr/bin/env python3
"""Entry point for the BUNDLED 'microSAMPLER Library' app (PyInstaller).

Wraps bridge.py --library for a double-clickable, no-terminal experience:
  * backups go to a per-user data dir (not inside the app bundle, which is
    read-only / replaced on update)
  * the bundled web-editor/ is served via MSMPL_WEB_ROOT
  * MSMPL_ALLOW_SHUTDOWN=1 enables POST /api/shutdown, so the web UI shows a
    QUIT button (there is no terminal to Ctrl+C)
  * the default browser opens once the server answers; if a library bridge is
    ALREADY running on the port, just open it (mirrors the .command launcher)
  * stdout/stderr go to <data dir>/library.log when frozen (windowed apps may
    have no usable stdio)

Build: pyinstaller tools/bundle/library.spec  (see .github/workflows/package.yml)
Plain `python3 tools/bundle/library_app.py` also works for a quick local run.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

PORT = 8766          # library mode's own port (device bridge uses 8765)


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
        s.bind(('127.0.0.1', port))
        s.close()
        return True
    except OSError:
        return False


def open_when_up(url, port):
    """Poll until the server accepts connections, then open the browser."""
    for _ in range(240):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.5).close()
            webbrowser.open(url)
            return
        except OSError:
            time.sleep(0.25)


def main():
    data = user_data_dir()
    os.makedirs(os.path.join(data, 'backups'), exist_ok=True)

    if getattr(sys, 'frozen', False):
        # windowed bundles may have no stdio — keep a log for troubleshooting
        log = open(os.path.join(data, 'library.log'), 'a', buffering=1)
        sys.stdout = sys.stderr = log
        print('--- microSAMPLER Library started', time.strftime('%Y-%m-%d %H:%M:%S'))

    port = PORT
    if not port_free(port):
        if library_bridge_at(port):     # already running → just open its UI
            webbrowser.open('http://localhost:%d' % port)
            return 0
        s = socket.socket()             # something else owns 8766 → any free port
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()

    root = resource_root()
    os.environ['MSMPL_WEB_ROOT'] = os.path.join(root, 'web-editor')
    os.environ.setdefault('MSMPL_BACKUP_DIR', os.path.join(data, 'backups'))
    os.environ['MSMPL_ALLOW_SHUTDOWN'] = '1'

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
