#!/usr/bin/env python3
"""Entry point for the BUNDLED device bridge — the launchd ROOT DAEMON inside
"microSAMPLER Editor Librarian.app" (see tools/bundle/editor-app/).

Runs bridge.py in DAEMON mode on the standard device port 8765:
  * device UNCLAIMED at start; claimed lazily when the editor page opens,
    auto-released after MSMPL_IDLE_RELEASE s with no UI (so the daemon can run
    24/7 without hogging the microSAMPLER from DAWs)
  * backups go to /Users/Shared (a root daemon has no meaningful $HOME, and
    the web UI reaches them over HTTP anyway — zip export/import/cherry-pick)
  * logging is launchd's job (StandardOutPath/StandardErrorPath in the plist)

Local test without the .app (unfrozen, needs sudo like the CLI bridge):
  sudo python3 tools/bundle/editor_daemon.py
"""
import os
import sys

PORT = 8765


def resource_root():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', '..'))


def main():
    root = resource_root()
    if getattr(sys, 'frozen', False):
        os.environ['MSMPL_WEB_ROOT'] = os.path.join(root, 'web-editor')
    os.environ['MSMPL_DAEMON'] = '1'
    if sys.platform == 'darwin':
        data = '/Users/Shared/DehliMusikk/microSAMPLER Editor'
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
