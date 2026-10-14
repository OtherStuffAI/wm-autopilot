import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";
import {beginGooseTurn, completeGooseTurn} from '../sessions/goose-turn-journal';

const DEFAULT_GOOSE_CLI = "/usr/local/bin/goose";

export function buildGooseRuntimeEnv(context: AdapterSessionContext): Record<string, string> {
  const env = {
    ...(process.env as Record<string, string>),
    ...(context.env ?? {}),
  };
  const model = context.model?.trim();
  if (model) env.GOOSE_MODEL = model;
  const provider = context.gooseCompletedTurn ? "openrouter" : env.GOOSE_PROVIDER?.trim() || context.gooseProvider?.trim();
  if (provider) env.GOOSE_PROVIDER = provider;
  if(context.gooseCompletedTurn){
    if(!env.OPENROUTER_API_KEY?.trim())throw Error("Goose completed turns require managed OpenRouter credentials");
    env.GOOSE_PROVIDER__API_KEY=env.OPENROUTER_API_KEY;
    env.GOOSE_PROVIDER__HOST=env.OPENROUTER_HOST?.trim()||"https://openrouter.ai/api";
  }
  if (env.OPENROUTER_API_KEY && !env.GOOSE_PROVIDER__API_KEY) {
    env.GOOSE_PROVIDER__API_KEY = env.OPENROUTER_API_KEY;
  }
  if (env.OPENROUTER_HOST && !env.GOOSE_PROVIDER__HOST) {
    env.GOOSE_PROVIDER__HOST = env.OPENROUTER_HOST;
  }
  return env;
}

export class GooseAdapter extends AcpAdapter {
  private readonly directory: string;
  private completedTurnActive = false;
  constructor(context: AdapterSessionContext) {
    const env = buildGooseRuntimeEnv(context);
    super(context, {
      agentName: "Goose",
      command: context.gooseCli || env.GOOSE_CLI || DEFAULT_GOOSE_CLI,
      args: ["acp"],
      env,
      protocolVersion: 0,
      sessionId: context.gooseSessionId,
    });
    this.directory = context.workingDirectory ?? '';
  }

  async sendCompletedMessage(prompt:string):Promise<string> {
    if(this.completedTurnActive)throw Error('Goose completed turn already active');
    this.completedTurnActive=true;
    try {
      if((await this.getPromptReadiness()).state!=="ready")throw Error("Goose completed turn requires an idle native session");
      const nativeSessionId=this.getSessionId();
      if(!nativeSessionId)throw Error('Goose native conversation missing');
      const context={nativeSessionId,directory:this.directory};
      const id=beginGooseTurn(context,prompt);
      const before=(await this.fetchMessages()).at(-1)?.turnId;
      const response=await this.sendPrompt(prompt);
      if((response.result as Record<string,unknown>|undefined)?.stopReason!=='end_turn')throw Error('Goose turn did not finish normally');
      const messages=await this.fetchMessages(),user=messages.findLast(m=>m.role==='user');
      if(!user?.turnId||user.turnId===before||user.content!==prompt)throw Error('Goose completed prompt correlation missing');
      const final=messages.findLast(m=>m.role==='assistant'&&m.turnId===user.turnId);
      if(!final?.content.trim())throw Error('Goose completed turn has no final answer');
      completeGooseTurn(context,id,final.content);
      return final.content;
    }finally{this.completedTurnActive=false}
  }
}
