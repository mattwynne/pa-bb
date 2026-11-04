export const sectionArgs = {account:'section@example.test',document:'doc-section',tabId:'tab-a',expectedRevisionId:'r1',heading:'Focus',newText:'Fresh 😀.\nSecond.'};
export function paragraph(start,end,text,paragraphStyle={namedStyleType:'NORMAL_TEXT'},textStyle={bold:true}) {
 return {startIndex:start,endIndex:end,paragraph:{paragraphStyle,elements:[{startIndex:start,endIndex:end,textRun:{content:text,textStyle}}]}};
}
const heading = (s,e,text) => paragraph(s,e,text,{namedStyleType:'HEADING_1',headingId:'h-'+text.trim()},{bold:false});
const table = (s,e,ps,pe) => ({startIndex:s,endIndex:e,table:{rows:1,columns:1,tableRows:[{startIndex:s+1,endIndex:e-1,tableCells:[{startIndex:s+2,endIndex:e-1,content:[paragraph(ps,pe,'X\n')]}]}]}});
export function sectionVector() {
 const before={documentId:'doc-section',revisionId:'r1',title:'Synthetic section',suggestionsViewMode:'SUGGESTIONS_INLINE',inlineObjects:{logo:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://example.test/read',sourceUri:'https://example.test/logo.png'}}}}},tabs:[{tabProperties:{tabId:'tab-a',title:'Main'},documentTab:{body:{content:[{endIndex:1,sectionBreak:{}},heading(1,7,'Focus\n'),paragraph(7,12,'Old.\n'),paragraph(12,18,'More.\n'),heading(18,23,'Tail\n'),table(24,30,27,29),paragraph(30,31,'\n')]}},childTabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[{endIndex:1,sectionBreak:{}},paragraph(1,7,'Other\n')]}}}]}]};
 const after=structuredClone(before);after.revisionId='r2';
 after.tabs[0].documentTab.body.content=[{endIndex:1,sectionBreak:{}},heading(1,7,'Focus\n'),paragraph(7,17,'Fresh 😀.\n'),paragraph(17,25,'Second.\n'),heading(25,30,'Tail\n'),table(31,37,34,36),paragraph(37,38,'\n')];
 const wire={writeControl:{requiredRevisionId:'r1'},requests:[{deleteContentRange:{range:{tabId:'tab-a',startIndex:7,endIndex:17}}},{insertText:{location:{tabId:'tab-a',index:7},text:'Fresh 😀.\nSecond.'}},{updateTextStyle:{range:{tabId:'tab-a',startIndex:7,endIndex:25},textStyle:{bold:true},fields:'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link'}},{updateParagraphStyle:{range:{tabId:'tab-a',startIndex:7,endIndex:25},paragraphStyle:{namedStyleType:'NORMAL_TEXT',direction:'LEFT_TO_RIGHT'},fields:'namedStyleType,direction'}}]};
 return {before,after,wire,args:{...sectionArgs}};
}
