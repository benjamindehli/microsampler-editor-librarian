#!/usr/bin/env python3
"""Entry point for the BUNDLED device bridge — the launchd ROOT DAEMON inside
"microSAMPLER Editor Librarian.app" (see tools/bundle/editor-app/).

Runs bridge.py in DAEMON mode on the standard device port 8765:
  * device UNCLAIMED at start; claimed lazily when the editor page opens,
    auto-released after MSMPL_IDLE_RELEASE s with no UI (so the daemon can run
    24/7 without hogging the microSAMPLER from DAWs)
  * backups go to /Users/Shared (a root daemon has no meaningful $HOME, and
    the web UI reaches them over HTTP anyway — zip export/import/cherry-pick),
    but only once secure_dir() has verified the path can't be redirected —
    else the root-only FALLBACK under /Library/Application Support
  * logging is launchd's job (StandardOutPath/StandardErrorPath in the plist)

Local test without the .app (unfrozen, needs sudo like the CLI bridge):
  sudo python3 tools/bundle/editor_daemon.py
"""
import os
import stat
import sys

PORT = 8765
SHARED = '/Users/Shared'
DATA = SHARED + '/DehliMusikk/microSAMPLER Editor'
FALLBACK = '/Library/Application Support/DehliMusikk/microSAMPLER Editor'


def secure_dir(path, base, owner=0):
    """Create `path` (below the existing `base`) one component at a time and
    verify that NO component — base included — is a symlink, a non-directory,
    or owned by anyone but `owner` (root), and that none below base is
    group/other-writable. /Users/Shared is writable by every account, so
    without this another local user could pre-create DehliMusikk as a symlink
    and this ROOT daemon would write backups (incl. imported zip contents)
    wherever it points. Checking once at start is sound: base must be sticky
    if world-writable, so nobody can rename or replace our root-owned entries
    later. Returns True when the whole path is safe to use."""
    rel = os.path.relpath(path, base)
    if rel.startswith(os.pardir):
        return False
    cur = base
    for part in [None] + rel.split(os.sep):
        if part is not None:
            cur = os.path.join(cur, part)
            try:
                os.mkdir(cur)
                os.chmod(cur, 0o755)       # explicit: don't trust the umask
            except FileExistsError:
                pass
            except OSError:
                return False
        try:
            st = os.lstat(cur)
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) \
                or st.st_uid != owner:
            return False
        writable = st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        if part is None:                   # base: shared by design, but then
            if st.st_mode & stat.S_IWOTH and not st.st_mode & stat.S_ISVTX:
                return False               # it must be sticky
        elif writable:
            return False
    return True


def resource_root():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', '..', 'src'))


def main():
    root = resource_root()
    if getattr(sys, 'frozen', False):
        os.environ['MSMPL_WEB_ROOT'] = os.path.join(root, 'web-editor')
    os.environ['MSMPL_DAEMON'] = '1'
    if sys.platform == 'darwin' and os.geteuid() == 0:
        data = DATA
        if not secure_dir(os.path.join(data, 'backups'), SHARED):
            # tampered with (or hand-edited): don't follow it as root. Backups
            # made before stay where they are; the log says why they're hidden.
            sys.stderr.write('WARNING: %s is a symlink, not owned by root, or '
                             'writable by others — using %s instead\n'
                             % (data, FALLBACK))
            data = FALLBACK
            os.makedirs(os.path.join(data, 'backups'), mode=0o755, exist_ok=True)
    elif sys.platform == 'darwin':           # unfrozen dev run without sudo
        data = DATA
        os.makedirs(os.path.join(data, 'backups'), exist_ok=True)
    else:                                    # unfrozen dev / future Linux daemon
        data = os.path.join(os.environ.get('XDG_DATA_HOME')
                            or os.path.expanduser('~/.local/share'),
                            'DehliMusikk', 'microSAMPLER Editor')
        os.makedirs(os.path.join(data, 'backups'), exist_ok=True)
    os.environ.setdefault('MSMPL_BACKUP_DIR', os.path.join(data, 'backups'))

    if sys.platform == 'darwin' and os.geteuid() == 0:
        # launchd creates our log dir/file root-only — open them up so users
        # can `tail` without sudo (log content is transfer chatter, not secrets)
        for path, mode in (('/Library/Logs/DehliMusikk', 0o755),
                           ('/Library/Logs/DehliMusikk/msmpl-bridge.log', 0o644)):
            try:
                os.chmod(path, mode)
            except OSError:
                pass
        # a KeepAlive daemon logs for months — let macOS's newsyslog rotate it
        # (checked hourly: rotate at 5 MB, keep 3 bzip2'd generations)
        conf = '/etc/newsyslog.d/no.dehlimusikk.msmpl.conf'
        if not os.path.exists(conf):
            try:
                with open(conf, 'w') as f:
                    f.write('# microSAMPLER bridge daemon log rotation\n'
                            '/Library/Logs/DehliMusikk/msmpl-bridge.log'
                            ' 644 3 5120 * J\n')
            except OSError:
                pass

    sys.path.insert(0, os.path.join(root, 'native-tools'))
    sys.argv = ['bridge.py', '--daemon', '--port', str(PORT)]
    import bridge
    return bridge.main()


if __name__ == '__main__':
    sys.exit(main())
