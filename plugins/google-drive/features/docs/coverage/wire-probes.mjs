import { readFileSync } from 'node:fs';
const vectors = { ...JSON.parse(readFileSync(new URL('./fixtures/wire-vectors.json', import.meta.url))),
  ...JSON.parse(readFileSync(new URL('./fixtures/correction-vectors.json', import.meta.url))) };
const residuals = JSON.parse(readFileSync(new URL('./fixtures/residual-vectors.json', import.meta.url)));
export function weightedFontProbe(context, weight) {
  if (!Object.hasOwn(residuals.fonts, context) || !Object.hasOwn(residuals.weights, weight)) throw new Error('unknown font fixture');
  const vector = structuredClone(residuals.fonts[context]);
  const style = context === 'text' ? vector.request.updateTextStyle.textStyle : vector.request.updateNamedStyle.namedStyle.textStyle;
  if (Object.hasOwn(residuals.weights[weight], 'value')) style.weightedFontFamily.weight = residuals.weights[weight].value;
  return vector;
}
export function wireProbe(name) {
  if (vectors[name]?.request) return structuredClone(vectors[name]);
  const base = ({ boldString:'bold', namedStyleMissingMasks:'namedStyle', namedStyleImplicitClear:'namedStyleClear', documentSize:'pageSize', dimensionString:'pageSize',dimensionZero:'pageSize',dimensionUnit:'pageSize',nestedPath:'pageSize',columnWidth:'tableWidth',outputHeader:'pageSize',outputSectionWidth:'sectionGap',outputDate:'date',outputEnum:'date',partialBorder:'border',partialBorderMask:'border',undeclaredReset:'resetBold',wildcard:'bold',rootMask:'bold',unmaskedValue:'bold',arrayType:'tableWidth' })[name];
  if (name === 'unsupportedValidator') return {request:{insertTable:{rows:1,columns:1,location:{tabId:'tab-a',index:1}}}};
  if (!base) throw new Error(`unknown wire probe ${name}`);
  const v = structuredClone(vectors[base]), p = Object.values(v.request)[0];
  if (name === 'boldString') p.textStyle.bold = 'true';
  if (name === 'namedStyleMissingMasks') p.fields = 'text_style.bold';
  if (name === 'namedStyleImplicitClear' || name === 'undeclaredReset') delete v.effects;
  if (name === 'documentSize') { p.documentStyle.documentSize = p.documentStyle.pageSize; delete p.documentStyle.pageSize; p.fields = 'documentSize'; }
  if (name === 'dimensionString') p.documentStyle.pageSize.width.magnitude = '612';
  if (name === 'dimensionZero') p.documentStyle.pageSize.width.magnitude = 0;
  if (name === 'dimensionUnit') p.documentStyle.pageSize.width.unit = 'PX';
  if (name === 'nestedPath') p.fields = 'pageSize.width.bogus';
  if (name === 'columnWidth') { p.tableColumnProperties.columnWidth = p.tableColumnProperties.width; delete p.tableColumnProperties.width; p.fields = 'columnWidth,widthType'; }
  if (name === 'outputHeader') { p.documentStyle.defaultHeaderId = 'header'; p.fields += ',defaultHeaderId'; }
  if (name === 'outputSectionWidth') p.sectionStyle.columnProperties[0].width = {magnitude:72,unit:'PT'};
  if (name === 'outputDate') p.dateElementProperties.displayText = 'Nov 2';
  if (name === 'outputEnum') p.dateElementProperties.dateFormat = 'DATE_FORMAT_CUSTOM';
  if (name === 'partialBorder') delete p.paragraphStyle.borderBottom.padding;
  if (name === 'partialBorderMask') p.fields = 'borderBottom.width';
  if (name === 'wildcard') p.fields = '*';
  if (name === 'rootMask') p.fields = 'textStyle.bold';
  if (name === 'unmaskedValue') p.textStyle.italic = true;
  if (name === 'arrayType') p.columnIndices = ['0'];
  return v;
}
