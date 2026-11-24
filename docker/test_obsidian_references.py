"""Check the Obsidian references shipped with the plugin source and Docker build."""
import hashlib
import json
from pathlib import Path
import unittest


REFERENCE = Path(__file__).resolve().parents[1] / 'plugins/obsidian/docs/reference'


class ObsidianReferenceTests(unittest.TestCase):
    def test_only_the_mit_api_snapshot_is_bundled(self):
        for name in ('help', 'developer'):
            self.assertFalse((REFERENCE / name).exists(), f'Link to upstream {name} articles')

        manifest = json.loads((REFERENCE / 'sources.json').read_text())
        self.assertEqual([source['directory'] for source in manifest['sources']], ['api'])
        files = manifest['sources'][0]['files']
        declared = {entry['path'] for entry in files}
        self.assertTrue({'obsidian.d.ts', 'canvas.d.ts', 'LICENSE.md'} <= declared)
        api = REFERENCE / 'api'
        self.assertEqual({p.relative_to(api).as_posix() for p in api.rglob('*') if p.is_file()}, declared)
        for entry in files:
            with self.subTest(path=entry['path']):
                self.assertEqual(hashlib.sha256((api / entry['path']).read_bytes()).hexdigest(),
                                 entry['sha256'])
