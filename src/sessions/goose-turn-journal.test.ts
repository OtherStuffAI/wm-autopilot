import {beforeEach,afterEach,test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {beginGooseTurn,completeGooseTurn,gooseTurnCheckpoint,recoverGooseTurn} from './goose-turn-journal';
let root:string,previous:string|undefined;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'goose-terminal-'));previous=process.env.WINGMAN_GOOSE_TURN_JOURNAL_DIR;process.env.WINGMAN_GOOSE_TURN_JOURNAL_DIR=root});
afterEach(()=>{if(previous===undefined)delete process.env.WINGMAN_GOOSE_TURN_JOURNAL_DIR;else process.env.WINGMAN_GOOSE_TURN_JOURNAL_DIR=previous;rmSync(root,{recursive:true,force:true})});
const c={nativeSessionId:'native',directory:'/exact'};
test('durable terminal evidence correlates repeated prompts after exact checkpoint and isolates native binding',()=>{
 const first=beginGooseTurn(c,'same');expect(recoverGooseTurn(c,0,'same')).toBeNull();completeGooseTurn(c,first,'first');
 const checkpoint=gooseTurnCheckpoint(c);const second=beginGooseTurn(c,'same');completeGooseTurn(c,second,'second');
 expect(recoverGooseTurn(c,checkpoint,'same')).toBe('second');
 expect(()=>recoverGooseTurn(c,checkpoint,'foreign')).toThrow('prompt mismatch');
 expect(gooseTurnCheckpoint({...c,directory:'/foreign'})).toBe(0);
 expect(statSync(join(root,readdirSync(root)[0]!)).mode&0o777).toBe(0o600);
 expect(()=>completeGooseTurn(c,second,'duplicate')).toThrow('correlation');
});
test('crash before terminal journal never authorizes replay or recovers from prose',()=>{
 beginGooseTurn(c,'publish');expect(recoverGooseTurn(c,0,'publish')).toBeNull();expect(()=>beginGooseTurn(c,'publish')).toThrow('replay refused');
 const file=join(root,readdirSync(root)[0]!);writeFileSync(file,'{}');expect(()=>recoverGooseTurn(c,0,'publish')).toThrow('binding');
});
