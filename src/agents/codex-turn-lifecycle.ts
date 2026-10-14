/** Abort and confirm native stream settlement before granting a replacement. */
export class CodexTurnLifecycle {
  controller:AbortController|null=null;
  private settled:Promise<void>|null=null;
  private settle:(()=>void)|null=null;
  begin():AbortController {
    if(this.controller)throw new Error("Codex native turn is already active");
    this.controller=new AbortController();
    this.settled=new Promise<void>(resolve=>{this.settle=resolve;});
    return this.controller;
  }
  finish(controller:AbortController):void {
    if(this.controller!==controller)return;
    this.controller=null;
    this.settle?.();this.settle=null;this.settled=null;
  }
  interrupt():boolean {
    if(!this.controller)return false;
    this.controller.abort();return true;
  }
  async dispose():Promise<void> {
    this.controller?.abort();
    if(!this.settled)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([this.settled,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error("Codex turn did not stop; replacement refused")),10_000);
      })]);
    } finally {if(timer)clearTimeout(timer);}
  }
}
