// Original literal vectors; no production request or expected-model generator.
export const draftOwner={subject:'draft-subject',account:'writer@example.test',threadId:'draft-thread'};
export const draftBinding={...draftOwner,snapshotId:'draft-snapshot',documentId:'draft-doc',view:'inline',retrievedAt:0};
export function validDraftDocument(){return {documentId:'draft-doc',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Main',index:0},documentTab:{body:{content:[
  {startIndex:1,endIndex:6,paragraph:{elements:[{startIndex:1,endIndex:4,textRun:{content:'A😀',textStyle:{bold:false,italic:true}}},{startIndex:4,endIndex:6,textRun:{content:'x\n',textStyle:{bold:false}}}]}},
  {startIndex:6,endIndex:11,paragraph:{elements:[{startIndex:6,endIndex:11,textRun:{content:'Keep\n',textStyle:{bold:false}}}]}}
]}}}]};}
export function boldAfter(){return {documentId:'draft-doc',revisionId:'r2',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Main',index:0},documentTab:{body:{content:[
  {startIndex:1,endIndex:6,paragraph:{elements:[{startIndex:1,endIndex:4,textRun:{content:'A😀',textStyle:{bold:true,italic:true}}},{startIndex:4,endIndex:6,textRun:{content:'x\n',textStyle:{bold:true}}}]}},
  {startIndex:6,endIndex:11,paragraph:{elements:[{startIndex:6,endIndex:11,textRun:{content:'Keep\n',textStyle:{bold:false}}}]}}
]}}}]};}
export const boldRequest={writeControl:{requiredRevisionId:'r1',writeMode:'EDIT'},requests:[{updateTextStyle:{range:{tabId:'tab-a',startIndex:1,endIndex:6},textStyle:{bold:true},fields:'bold'}}]};
export const operationKeys=Array.from({length:20},(_,i)=>`a0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
