"""Exercise the image-only workflow with existing image fixtures; no image generation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import shutil
import subprocess
import tempfile
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--node', required=True)
    p.add_argument('--modules', required=True)
    p.add_argument('--fixture-a', required=True)
    p.add_argument('--fixture-b', required=True)
    p.add_argument('--workdir', required=True)
    a = p.parse_args()
    base = Path(a.workdir).resolve()
    base.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='image-ppt-', dir=base))
    project = run / '中文项目 with spaces'
    script = Path(__file__).with_name('deck.cjs')

    def cli(cmd, *args, ok=True):
        r = subprocess.run([a.node, str(script), cmd, '--project', str(project), *args],
                           capture_output=True, text=True, encoding='utf-8')
        if ok:
            assert r.returncode == 0, r.stderr
            return json.loads(r.stdout)
        assert r.returncode != 0, 'Expected failure: ' + cmd
        return r.stderr

    cli('init', '--title', '图片版PPT测试 <价格 & 案例>')
    fixtures = []
    for i, src in enumerate([a.fixture_a, a.fixture_b], 1):
        target = project / 'renders' / ('页面' + str(i) + Path(src).suffix.lower())
        shutil.copyfile(src, target)
        fixtures.append(target.relative_to(project).as_posix())
    (project / 'prompts' / 'offer.md').write_text('测试文案：共享全球买家库。', encoding='utf-8')
    cli('add', '--id', 'offer', '--title', '价格 <页>', '--image', fixtures[0], '--prompt', 'prompts/offer.md', '--notes', '准确价格 & 来源')
    cli('add', '--id', 'ending', '--title', '结束页', '--image', fixtures[1], '--after', 'offer')
    cli('add', '--id', 'opening', '--title', '开场', '--image', fixtures[1], '--first')
    assert [s['id'] for s in cli('list')['slides']] == ['opening', 'offer', 'ending']
    manifest = project / 'manifest.json'
    before = manifest.read_bytes()
    cli('add', '--id', 'offer', '--title', '重复', '--image', fixtures[0], ok=False)
    cli('replace', '--id', 'offer', '--image', '../outside.png', ok=False)
    cli('remove', '--id', 'missing', ok=False)
    assert manifest.read_bytes() == before
    cli('replace', '--id', 'ending', '--image', fixtures[0], '--title', '已换图')
    cli('remove', '--id', 'opening')
    assert (project / fixtures[1]).exists(), 'Removal must preserve assets'
    assert len(list((project / 'revisions').glob('manifest-*.json'))) == 5
    assert cli('check')['slide_count'] == 2

    first = cli('build', '--modules', a.modules, '--compact', '--version', 'v001')
    release = Path(first['path'])
    old_hashes = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in release.glob('*.pptx')}
    latest = (project / 'output' / 'LATEST.json').read_bytes()
    cli('build', '--modules', a.modules, '--version', 'v001', ok=False)
    assert (project / 'output' / 'LATEST.json').read_bytes() == latest
    cli('replace', '--id', 'ending', '--image', fixtures[1])
    second = cli('build', '--modules', a.modules, '--version', 'v002')
    assert old_hashes == {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in release.glob('*.pptx')}
    assert second['slide_count'] == 2 and len(second['pptx']) == 1
    assert (project / 'output' / 'v001' / 'preview' / 'index.html').exists()
    assert not (project / '.image-ppt.lock').exists()

    ns = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
          'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
          'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    for result in [first, second]:
        folder = Path(result['path'])
        snapshot = json.loads((folder / 'manifest.json').read_text('utf-8'))
        assert [s['id'] for s in snapshot['slides']] == ['offer', 'ending']
        for slide in snapshot['slides']:
            assert (folder / slide['image']).exists()
            if 'prompt' in slide:
                assert (folder / slide['prompt']).exists()
        for deck in result['pptx']:
            with ZipFile(deck) as z:
                assert z.testzip() is None
                for name in z.namelist():
                    if name.endswith(('.xml', '.rels')):
                        ET.fromstring(z.read(name))
                doc = ET.fromstring(z.read('ppt/presentation.xml'))
                ids = doc.find('p:sldIdLst', ns)
                assert len(ids) == 2
                sz = doc.find('p:sldSz', ns)
                assert abs(int(sz.get('cx')) / int(sz.get('cy')) - 16 / 9) < .0001
                presrels = {r.get('Id'):r.get('Target') for r in ET.fromstring(z.read('ppt/_rels/presentation.xml.rels'))}
                for i, sid in enumerate(ids):
                    target = presrels[sid.get('{'+ns['r']+'}id')]
                    sp = posixpath.normpath(posixpath.join('ppt', target))
                    slide = ET.fromstring(z.read(sp))
                    pictures = slide.findall('.//p:pic', ns)
                    assert len(pictures) == 1
                    rid = pictures[0].find('.//a:blip', ns).get('{'+ns['r']+'}embed')
                    relpath = posixpath.dirname(sp) + '/_rels/' + posixpath.basename(sp) + '.rels'
                    rels = {r.get('Id'):r.get('Target') for r in ET.fromstring(z.read(relpath))}
                    media = posixpath.normpath(posixpath.join(posixpath.dirname(sp), rels[rid]))
                    if deck.endswith('deck-hd.pptx'):
                        assert hashlib.sha256(z.read(media)).digest() == hashlib.sha256((folder / snapshot['slides'][i]['image']).read_bytes()).digest()
    print(json.dumps({'status':'passed','checks':['insert/order','replace','remove-keeps-assets','manifest-backups','invalid-input-no-mutation','immutable-releases','hd-and-compact-build','offline-preview','valid-xml-and-relationships','16:9','source-image-integrity'], 'project':str(project), 'first':first, 'latest':second}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
