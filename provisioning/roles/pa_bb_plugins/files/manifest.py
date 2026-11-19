#!/usr/bin/env python3
"""Read Git's desired plugin set and BB's registrations. Never change either."""
import json
from pathlib import Path
import re
import subprocess
import sys


class Refusal(Exception):
    pass


def command(argv, cwd=None):
    try:
        return subprocess.run(argv, cwd=cwd, check=True, capture_output=True,
                              text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        raise Refusal('Could not inspect Git or BB; no plugin changes were attempted.') from None


def plugin_id(package):
    name = package.get('name')
    if not isinstance(name, str) or not name:
        raise Refusal('A tracked plugin has no package name.')
    value = re.sub(r'[^a-z0-9-]', '-', re.sub(r'^bb-plugin-', '', name.split('/')[-1]).lower()).strip('-')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', value):
        raise Refusal('A tracked plugin has an invalid ID.')
    return value


def discover(checkout, ref='main'):
    root = Path(checkout).resolve(strict=True)
    if Path(command(['git', 'rev-parse', '--show-toplevel'], root).strip()).resolve() != root:
        raise Refusal('The source directory must be the root of a Git checkout.')
    revision = command(['git', 'rev-parse', '--verify', ref + '^{commit}'], root).strip()
    tracked = command(['git', 'ls-tree', '-rz', '--name-only', revision, '--', 'plugins'], root).split('\0')
    plugins = []
    ids = set()
    for relative in sorted(tracked):
        parts = Path(relative).parts
        if len(parts) != 3 or parts[0] != 'plugins' or parts[2] != 'package.json':
            continue
        package = json.loads(command(['git', 'show', revision + ':' + relative], root))
        if not isinstance(package.get('bb'), dict):
            continue
        identity = plugin_id(package)
        if identity in ids:
            raise Refusal('Tracked plugins have duplicate IDs.')
        ids.add(identity)
        path = (root / relative).parent.resolve(strict=True)
        if path.parent != root / 'plugins':
            raise Refusal('A plugin path escapes the checkout.')
        current = json.loads((path / 'package.json').read_text())
        if plugin_id(current) != identity or not isinstance(current.get('bb'), dict):
            raise Refusal('A working plugin manifest has a different identity from main; inspect it first.')
        if str(Path(relative).with_name('package-lock.json')) not in tracked or not (path / 'package-lock.json').is_file():
            raise Refusal('Every plugin needs a tracked package lock.')
        plugins.append({'id': identity, 'path': str(path), 'source': 'path:' + str(path)})
    if not plugins:
        raise Refusal('No tracked BB plugin manifests were found; refusing an empty desired set.')
    return revision, plugins


def plan(checkout, plugins, installed):
    root = Path(checkout).resolve()
    by_id = {}
    for item in installed:
        identity = item['id']
        if (not isinstance(identity, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', identity)
                or not isinstance(item.get('source'), str) or not isinstance(item.get('enabled'), bool)):
            raise Refusal('BB returned an invalid plugin registration.')
        if identity in by_id:
            raise Refusal('BB returned duplicate plugin registrations.')
        by_id[identity] = item
    for plugin in plugins:
        existing = by_id.get(plugin['id'])
        if existing and (existing['source'] != plugin['source'] or existing.get('provenance', 'direct') != 'direct'):
            raise Refusal('An existing plugin has a different source; provisioning never switches sources.')
        plugin.update(installed=existing is not None, enabled=existing['enabled'] if existing else True)
    desired = {p['id'] for p in plugins}
    retired = []
    for item in installed:
        source = item['source']
        if not source.startswith('path:'):
            continue
        path = Path(source[5:]).resolve()
        if path.parent == root / 'plugins' and item['id'] not in desired:
            if item.get('provenance', 'direct') != 'direct':
                raise Refusal('A PA path has unexpected provenance; inspect it before removal.')
            retired.append({k: item[k] for k in ['id', 'source', 'enabled']})
    return {'plugins': plugins, 'retired': retired,
            'preserved': [{k: p[k] for k in ['id', 'source', 'enabled']} for p in installed if p['id'] not in {r['id'] for r in retired}]}


def main():
    try:
        checkout, ref, *cli = sys.argv[1:]
        revision, plugins = discover(checkout, ref)
        installed = json.loads(command(cli + ['plugin', 'list', '--json']))['plugins']
        result = plan(checkout, plugins, installed)
        result['revision'] = revision
        print(json.dumps(result))
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error) if isinstance(error, Refusal) else 'Could not validate plugin inventory; no changes were attempted.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
