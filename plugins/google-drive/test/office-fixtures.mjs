import { zipSync, strToU8 } from 'fflate';
export const O = 'http://schemas.openxmlformats.org/';
export const W = `${O}wordprocessingml/2006/main`, P = `${O}presentationml/2006/main`, A = `${O}drawingml/2006/main`, R = `${O}officeDocument/2006/relationships`;
export function officeFixture(mode = 'docx_to_doc', options = {}) {
  const word = mode === 'docx_to_doc', main = word ? 'word/document.xml' : 'ppt/presentation.xml';
  const types = word ? { [main]: 'wordprocessingml.document.main' } : { [main]: 'presentationml.presentation.main', 'ppt/slides/slide1.xml': 'presentationml.slide', 'ppt/slides/slide2.xml': 'presentationml.slide' };
  const files = { '[Content_Types].xml': `<Types xmlns="${O}package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${Object.entries(types).map(([p,t]) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.${t}+xml"/>`).join('')}${options.types || ''}</Types>`,
    '_rels/.rels': `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="main" Type="${R}/officeDocument" Target="${main}"/></Relationships>`,
    [main]: word ? `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>Hello editable world</w:t></w:r></w:p>${options.body || ''}</w:body></w:document>`
      : `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s2"/></p:sldIdLst>${options.body || ''}</p:presentation>`,
    ...(word ? {} : {
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${O}package/2006/relationships"><Relationship Id="s1" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Id="s2" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`,
      ...Object.fromEntries([1,2].map(n => [`ppt/slides/slide${n}.xml`, `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide ${n} editable text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`])),
    }), ...options.extra,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k,v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
}
