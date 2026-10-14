import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, isAbsolute} from 'node:path';

export interface ClaudeTurnContext {nativeSessionId:string;directory:string}
interface Journal {schema:1;nativeSessionId:string;directory:string;turns:Array<{id:string;prompt:string;reply:string|null}>}
function location(c:ClaudeTurnContext) {
 if(!c.nativeSessionId||!isAbsolute(c.directory))throw Error('Invalid Claude journal binding');
 const root=process.env.WINGMAN_CLAUDE_TURN_JOURNAL_DIR||join(homedir(),'.wingmen','runtime','claude-completed-turns');
 return {root,path:join(root,createHash('sha256').update(JSON.stringify([c.nativeSessionId,c.directory])).digest('hex')+'.json')};
}
function read(c:ClaudeTurnContext):Journal {
 const {path}=location(c);
 if(!existsSync(path))return {schema:1,...c,turns:[]};
 const d=JSON.parse(readFileSync(path,'utf8')) as Journal;
 if(d.schema!==1||d.nativeSessionId!==c.nativeSessionId||d.directory!==c.directory||!Array.isArray(d.turns)||d.turns.some(t=>typeof t.id!=='string'||typeof t.prompt!=='string'||(t.reply!==null&&typeof t.reply!=='string')))throw Error('Claude journal binding or records invalid');
 return d;
}
function write(c:ClaudeTurnContext,d:Journal) {
 const {root,path}=location(c);mkdirSync(root,{recursive:true,mode:0o700});
 const temp=path+'.'+randomUUID();const fd=openSync(temp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(d));fsyncSync(fd);}finally{closeSync(fd)}
 renameSync(temp,path);const directory=openSync(root,'r');try{fsyncSync(directory)}finally{closeSync(directory)}
}
/** Only the trusted SDK adapter writes terminal evidence; model prose and native chat records cannot fabricate completion. */
export function beginClaudeTurn(c:ClaudeTurnContext,prompt:string):string {
 const d=read(c);if(d.turns.at(-1)?.reply===null)throw Error('Claude journal contains an uncertain turn; replay refused');
 const id=randomUUID();d.turns.push({id,prompt,reply:null});write(c,d);return id;
}
export function completeClaudeTurn(c:ClaudeTurnContext,id:string,reply:string):void {
 const d=read(c),turn=d.turns.at(-1);if(!turn||turn.id!==id||turn.reply!==null||!reply.trim())throw Error('Claude terminal journal correlation denied');
 turn.reply=reply;write(c,d);
}
export function claudeTurnCheckpoint(c:ClaudeTurnContext):number{return read(c).turns.length}
export function recoverClaudeTurn(c:ClaudeTurnContext,checkpoint:number,prompt:string):string|null {
 const d=read(c);if(!Number.isInteger(checkpoint)||checkpoint<0||checkpoint>d.turns.length)throw Error('Claude checkpoint invalid');
 const turn=d.turns[checkpoint];if(!turn)return null;if(turn.prompt!==prompt)throw Error('Claude recovery prompt mismatch');
 return turn.reply;
}
