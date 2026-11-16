import {test} from "node:test";
import assert from "node:assert/strict";
import type {AssistantMessage,Models} from "@earendil-works/pi-ai";
import {PiGateway} from "./pi-gateway.js";
import {ModelRequestError} from "./gateway.js";
import type {Request} from "./types.js";

const model={api:"openai-completions",provider:"deepseek",id:"test"};
const request:Request={
    modelCallId:"call-1",model:{providerId:"deepseek",modelId:"test"},
    messages:[{role:"user",content:[{type:"text",text:"hello"}],timestamp:1}],
    tools:[],maxOutputTokens:100,thinkingJson:"{}",
};
const rawUsage={usage:{prompt_tokens:100,prompt_cache_hit_tokens:60,completion_tokens:20,total_tokens:120}};
function assistant(stopReason:"stop"|"aborted"):AssistantMessage{
    return {
        role:"assistant",api:"openai-completions",provider:"deepseek",model:"test",timestamp:1,
        stopReason,content:[{type:"text",text:"answer"}],
        usage:{input:40,output:20,cacheRead:60,cacheWrite:0,totalTokens:120,
            cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    };
}
function gateway(raw:unknown,stopReason:"stop"|"aborted"):PiGateway{
    const models={
        getModel:()=>model,
        streamSimple:(_model:unknown,_context:unknown,options:{onProviderStreamEvent?:(value:unknown)=>void})=>
            (async function*(){
                options.onProviderStreamEvent?.(raw);
                const message=assistant(stopReason);
                if(stopReason==="aborted") yield {type:"error",error:message};
                else yield {type:"done",message};
            })(),
    } as unknown as Models;
    return new PiGateway(models);
}

test("gateway uses raw usage and marks absent provider usage unknown",async()=>{
    for(const [raw,expected] of [[rawUsage,120],[{usage:null},null]] as const){
        const response=await gateway(raw,"stop").complete(request,new AbortController().signal);
        assert.equal(response.usage?.totalTokens??null,expected);
        if(response.usage){
            assert.equal(response.usage.cachedReadTokens,60);
            assert.equal(response.usage.cachedWriteTokens,null);
        }
    }
});

test("gateway carries observed usage through cancellation",async()=>{
    for(const [raw,expected] of [[rawUsage,120],[{usage:null},null]] as const){
        await assert.rejects(
            gateway(raw,"aborted").complete(request,new AbortController().signal),
            (error:unknown)=>error instanceof ModelRequestError&&error.name==="AbortError"
                &&(error.usage?.totalTokens??null)===expected,
        );
    }
});
