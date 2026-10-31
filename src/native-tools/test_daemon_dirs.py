"""Offline test of the Editor app daemon's backup-folder guard
(tools/bundle/editor_daemon.secure_dir): the ROOT daemon must never follow a
symlink or use a folder another account owns or can write. Runs unprivileged:
`owner` is the current uid here (root in the real daemon)."""
import os
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools', 'bundle'))
import editor_daemon as D  # noqa: E402

me = os.getuid()


def fresh_base():
    base = tempfile.mkdtemp()
    os.chmod(base, 0o1777)                 # like /Users/Shared: shared + sticky
    return base


# fresh install: the whole chain is created, owned by us, 0755
base = fresh_base()
path = os.path.join(base, 'DehliMusikk', 'microSAMPLER Editor', 'backups')
assert D.secure_dir(path, base, owner=me)
for sub in ('DehliMusikk', 'DehliMusikk/microSAMPLER Editor', path):
    st = os.lstat(os.path.join(base, sub))
    assert stat.S_ISDIR(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o755, sub
assert D.secure_dir(path, base, owner=me)     # existing + intact: still fine

# a pre-planted symlink at any level is refused, and NOT followed
base = fresh_base()
target = tempfile.mkdtemp()
os.symlink(target, os.path.join(base, 'DehliMusikk'))
assert not D.secure_dir(os.path.join(base, 'DehliMusikk', 'x'), base, owner=me)
assert os.listdir(target) == []                # nothing created through it

# a component owned by someone else is refused
base = fresh_base()
assert not D.secure_dir(os.path.join(base, 'a', 'b'), base, owner=me + 1)

# a group/other-writable component below base is refused
base = fresh_base()
os.mkdir(os.path.join(base, 'DehliMusikk'))
os.chmod(os.path.join(base, 'DehliMusikk'), 0o777)
assert not D.secure_dir(os.path.join(base, 'DehliMusikk', 'x'), base, owner=me)

# a regular FILE where a folder should be is refused
base = fresh_base()
open(os.path.join(base, 'DehliMusikk'), 'w').close()
assert not D.secure_dir(os.path.join(base, 'DehliMusikk', 'x'), base, owner=me)

# a world-writable base WITHOUT the sticky bit is refused (entries replaceable)
base = fresh_base()
os.chmod(base, 0o777)
assert not D.secure_dir(os.path.join(base, 'x'), base, owner=me)

# a path outside base is refused
assert not D.secure_dir('/etc', fresh_base(), owner=me)

print('daemon backup-folder guard: OK')
