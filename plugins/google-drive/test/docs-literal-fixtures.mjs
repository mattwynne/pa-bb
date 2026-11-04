// Handwritten rich provider observations and wire. No compiler/verifier imports.
export const literalStyle={bold:true,italic:false,fontSize:{magnitude:12,unit:'PT'}};
const run=(startIndex,endIndex,content)=>({startIndex,endIndex,textRun:{content,textStyle:structuredClone(literalStyle)}});
const paragraph=(startIndex,endIndex,content)=>({startIndex,endIndex,paragraph:{elements:[run(startIndex,endIndex,content)],paragraphStyle:{namedStyleType:'NORMAL_TEXT'}}});
export function richLiteralVector(kind='longer'){
 const before={documentId:'doc-rich',revisionId:'r1',title:'Rich synthetic document',suggestionsViewMode:'SUGGESTIONS_INLINE',opaqueMetadata:{startIndex:999,keep:'ROOT'},inlineObjects:{logo:{inlineObjectProperties:{embeddedObject:{title:'Unchanged logo',imageProperties:{contentUri:'https://example.test/logo.png'}}}}},tabs:[{tabProperties:{tabId:'main',title:'Main',index:0},documentTab:{namedStyles:{styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{weightedFontFamily:{fontFamily:'Arial'}}}]},body:{content:[
 {endIndex:1,sectionBreak:{}},paragraph(1,15,'Hello 😀 old.\n'),
 {startIndex:15,endIndex:17,paragraph:{elements:[{startIndex:15,endIndex:16,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:16,endIndex:17,textRun:{content:'\n'}}]}},
 {startIndex:17,endIndex:25,table:{rows:1,columns:1,tableRows:[{startIndex:18,endIndex:24,tableCells:[{startIndex:19,endIndex:23,tableCellStyle:{rowSpan:1,columnSpan:1},content:[{startIndex:20,endIndex:22,paragraph:{elements:[{startIndex:20,endIndex:22,textRun:{content:'Q\n'}}]}}]}]}]}},
 {startIndex:25,endIndex:30,paragraph:{elements:[{startIndex:25,endIndex:30,textRun:{content:'Tail\n',textStyle:{underline:false}}}]}}
 ]}}},{tabProperties:{tabId:'other',title:'Other',index:1},documentTab:{body:{content:[{endIndex:1,sectionBreak:{}},{startIndex:1,endIndex:6,paragraph:{elements:[{startIndex:1,endIndex:6,textRun:{content:'Keep\n'}}]}}]},opaqueTab:{endIndex:777}}}]};
 const after=structuredClone(before);after.revisionId='r2';after.tabs[0].documentTab.body.content=[
 {endIndex:1,sectionBreak:{}},{startIndex:1,endIndex:17,paragraph:{elements:[run(1,10,'Hello 😀 '),run(10,15,'newer'),run(15,17,'.\n')],paragraphStyle:{namedStyleType:'NORMAL_TEXT'}}},
 {startIndex:17,endIndex:19,paragraph:{elements:[{startIndex:17,endIndex:18,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:18,endIndex:19,textRun:{content:'\n'}}]}},
 {startIndex:19,endIndex:27,table:{rows:1,columns:1,tableRows:[{startIndex:20,endIndex:26,tableCells:[{startIndex:21,endIndex:25,tableCellStyle:{rowSpan:1,columnSpan:1},content:[{startIndex:22,endIndex:24,paragraph:{elements:[{startIndex:22,endIndex:24,textRun:{content:'Q\n'}}]}}]}]}]}},
 {startIndex:27,endIndex:32,paragraph:{elements:[{startIndex:27,endIndex:32,textRun:{content:'Tail\n',textStyle:{underline:false}}}]}}
 ];
 if(kind==='shorter'||kind==='delete'){
  const short=kind==='shorter';after.tabs[0].documentTab.body.content=[
   {endIndex:1,sectionBreak:{}},paragraph(1,short?13:12,short?'Hello 😀 x.\n':'Hello 😀 .\n'),
   {startIndex:short?13:12,endIndex:short?15:14,paragraph:{elements:[{startIndex:short?13:12,endIndex:short?14:13,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:short?14:13,endIndex:short?15:14,textRun:{content:'\n'}}]}},
   {startIndex:short?15:14,endIndex:short?23:22,table:{rows:1,columns:1,tableRows:[{startIndex:short?16:15,endIndex:short?22:21,tableCells:[{startIndex:short?17:16,endIndex:short?21:20,tableCellStyle:{rowSpan:1,columnSpan:1},content:[{startIndex:short?18:17,endIndex:short?20:19,paragraph:{elements:[{startIndex:short?18:17,endIndex:short?20:19,textRun:{content:'Q\n'}}]}}]}]}]}},
   {startIndex:short?23:22,endIndex:short?28:27,paragraph:{elements:[{startIndex:short?23:22,endIndex:short?28:27,textRun:{content:'Tail\n',textStyle:{underline:false}}}]}}
  ];
 }
 const newText=kind==='shorter'?'x':kind==='delete'?'':'newer';
 const value={before,after,args:{account:'writer@example.test',document:'doc-rich',tabId:'main',expectedRevisionId:'r1',oldText:'old',newText},wire:{writeControl:{requiredRevisionId:'r1'},requests:[{deleteContentRange:{range:{tabId:'main',startIndex:10,endIndex:13}}},{insertText:{location:{tabId:'main',index:10},text:newText}},{updateTextStyle:{range:{tabId:'main',startIndex:10,endIndex:10+newText.length},textStyle:structuredClone(literalStyle),fields:'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link'}}]}};
 if(kind==='delete')value.wire.requests=value.wire.requests.slice(0,1);
 if(kind==='astral'){
  value.args.oldText='😀';value.args.newText='🙂🙂';
  after.tabs[0].documentTab.body.content[1].paragraph.elements=[run(1,7,'Hello '),run(7,11,'🙂🙂'),run(11,17,' old.\n')];
  value.wire.requests=[{deleteContentRange:{range:{tabId:'main',startIndex:7,endIndex:9}}},{insertText:{location:{tabId:'main',index:7},text:'🙂🙂'}},{updateTextStyle:{range:{tabId:'main',startIndex:7,endIndex:11},textStyle:structuredClone(literalStyle),fields:'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link'}}];
 }
 return value;
}
