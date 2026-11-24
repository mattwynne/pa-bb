"""Print Docker's default seccomp profile with Chromium namespace access."""
import hashlib
import json
from urllib.request import urlopen


SOURCE = ('https://raw.githubusercontent.com/moby/profiles/'
          'a0fa70805f742f7da15b367770d802ea2a86c68b/seccomp/default.json')
SHA256 = '3320527d4568265ac97a077609b1bfd4cfd0d789eeb9239b7e094b1526675406'


def main():
    with urlopen(SOURCE, timeout=30) as response:
        data = response.read(128 * 1024)
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit('Docker seccomp profile checksum failed.')
    profile = json.loads(data)
    # Chromium creates a nested user namespace, then chroots within it.
    # The smoke container still drops every outer capability, including SYS_CHROOT.
    profile['syscalls'].append({
        'names': ['clone', 'setns', 'unshare', 'chroot'],
        'action': 'SCMP_ACT_ALLOW',
        'comment': 'Allow Chromium to create its user namespace sandbox',
    })
    print(json.dumps(profile, indent=2))


if __name__ == '__main__':
    main()
