import {nativeWorld} from './docs-semantic-native-fixtures.mjs';
import {textVector} from './docs-semantic-text-vectors.mjs';
export function textWorld(kind='longer',options={}){const v=textVector(kind);return nativeWorld({document:v.before,after:v.after,wire:v.wire,replyCount:v.replyCount??(kind==='delete'?1:kind==='insert'?2:3),sdkPlan:true,paragraphIndex:1,oldText:v.oldText,newText:v.newText,...options});}
