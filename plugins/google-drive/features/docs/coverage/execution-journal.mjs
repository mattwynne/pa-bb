import assert from 'node:assert/strict';
import { openSync,closeSync,fstatSync,readSync } from 'node:fs';
export const JOURNAL_LIMITS=Object.freeze({recordBytes:4*1024*1024,totalBytes:64*1024*1024,records:1024});
export const MESSAGE_LIMITS=Object.freeze({recordBytes:4*1024*1024,totalBytes:128*1024*1024,records:100000});
export function childTimeout(env=process.env) {
  const raw=env.DOCS_ACCEPTANCE_TIMEOUT_MS??'300000';
  assert.match(raw,/^[1-9]\d*$/,'positive child timeout required');
  const ms=Number(raw);assert.ok(Number.isSafeInteger(ms)&&ms<=600000,'child timeout exceeds 600000 ms');return ms;
}
export function publicationGuard(limits=JOURNAL_LIMITS) {
  let bytes=0,count=0;
  return receipt=>{
    const length=Buffer.byteLength(JSON.stringify(receipt))+1;
    assert.ok(length<=limits.recordBytes,'execution journal record byte limit');
    assert.ok(bytes+length<=limits.totalBytes,'execution journal aggregate byte limit');
    assert.ok(count+1<=limits.records,'execution journal record count limit');
    bytes+=length;count++;
  };
}
// Read bounded chunks, reject size/count/record overrun before parsing it, and
// keep the original artifact on every error. Never allocate from stat.size.
export function readJournal(path,limits=JOURNAL_LIMITS) {
  const fd=openSync(path,'r');
  try {
    const stat=fstatSync(fd);assert.ok(stat.isFile(),'journal must be regular');
    assert.ok(stat.size<=limits.totalBytes,'execution journal aggregate byte limit');
    const chunk=Buffer.alloc(64*1024),records=[];let parts=[],length=0,total=0;
    for(;;){
      const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;
      total+=n;assert.ok(total<=limits.totalBytes,'execution journal grew beyond aggregate byte limit');
      let start=0;
      while(start<n){
        const end=chunk.indexOf(10,start),newline=end>=0&&end<n,stop=newline?end+1:n;
        length+=stop-start;assert.ok(length<=limits.recordBytes,'execution journal record byte limit');
        parts.push(Buffer.from(chunk.subarray(start,stop)));start=stop;
        if(newline){
          assert.ok(records.length<limits.records,'execution journal record count limit');
          const bytes=Buffer.concat(parts,length);
          const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
          records.push(JSON.parse(text));parts=[];length=0;
        }
      }
    }
    if(length)throw new SyntaxError('truncated execution journal: missing final newline');
    return records;
  }finally{closeSync(fd);}
}
