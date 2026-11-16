import {test} from "node:test";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {RuntimeOptions} from "./runtime-options.js";
import type {LoopOptions} from "./types.js";
import {AgentSession} from "./session.js";
import {AgentLoop} from "./loop.js";
import {ToolRegistry} from "../tools/registry.js";
import type {ModelGateway} from "../model/gateway.js";
import type {Response} from "../model/types.js";

const base:LoopOptions={
    cwd:"/",model:{providerId:"test",modelId:"test"},thinkingJson:"{}",
    maxOutputTokens:8192,maxModelCalls:100,maxConcurrentTools:5,
    ToolExecutionMode:"sequential",contextWindow:100000,reserveTokens:16384,
};

test("set validates settings and gives each run an immutable option snapshot",()=>{
    const settings=new RuntimeOptions(base,"high",["off","low","high","max"],80000);
    const first=settings.get();
    const next=settings.set({reasoningLevel:"max",maxOutputTokens:32768,maxModelCalls:200,
        maxConcurrentTools:2,toolExecutionMode:"parallel"});
    assert.equal(first.maxOutputTokens,8192);
    assert.equal(first.ToolExecutionMode,"sequential");
    assert.equal(next.thinkingJson,'{"reasoning":"max"}');
    assert.equal(next.maxOutputTokens,32768);
    assert.equal(next.reserveTokens,32768);
    assert.equal(next.maxModelCalls,200);
    assert.equal(next.maxConcurrentTools,2);
    assert.equal(next.ToolExecutionMode,"parallel");
    assert.throws(()=>settings.set({reasoningLevel:"medium",maxModelCalls:300}),/不支持推理等级/);
    assert.throws(()=>settings.set({maxOutputTokens:80001}),/输出上限/);
    assert.throws(()=>settings.set({maxConcurrentTools:0}),/并发上限/);
    assert.equal(settings.get(),next);
    assert.equal(settings.set({reasoningLevel:"off"}).thinkingJson,"{}");
});

test("explicit compaction threshold rejects an incompatible output limit without changing settings",()=>{
    const settings=new RuntimeOptions(base,"high",["off","high"],80000,70000);
    assert.equal(settings.get().reserveTokens,30000);
    const before=settings.get();
    assert.throws(()=>settings.set({maxOutputTokens:32768}),/压缩阈值不兼容/);
    assert.equal(settings.get(),before);
});

function response(toolCalls:boolean):Response{
    return {
        termination:{kind:toolCalls?"TOOL_CALLS":"STOP",rawReason:null},usage:null,providerRequestId:null,
        message:{role:"assistant",timestamp:1,content:toolCalls?[
            {type:"tool_call",callId:"1",name:"read-test",argumentsJson:"{}"},
            {type:"tool_call",callId:"2",name:"read-test",argumentsJson:"{}"},
        ]:[{type:"text",text:"done"}]},
    };
}

test("execution mode and concurrency limit control a real tool batch",async()=>{
    for(const [mode,limit,expected] of [["sequential",5,1],["parallel",5,2],["parallel",1,1]] as const){
        let active=0;
        let maxActive=0;
        const registry=new ToolRegistry();
        registry.register({
            definition:{name:"read-test",description:"test",parametersJson:'{"type":"object","properties":{}}'},
            mode:"parallel",
            async execute(){
                active++;
                maxActive=Math.max(maxActive,active);
                await delay(10);
                active--;
                return {content:[{type:"text",text:"ok"}]};
            },
        });
        let calls=0;
        const gateway:ModelGateway={
            async complete(){throw new Error("Unexpected compaction");},
            async *stream(){yield {type:"done",response:response(calls++===0)};},
        };
        const session=new AgentSession(new AgentLoop(gateway,registry));
        const result=await session.prompt("test",{...base,ToolExecutionMode:mode,maxConcurrentTools:limit});
        assert.equal(result.stopReason,"stop");
        assert.equal(maxActive,expected);
    }
});

test("a batch containing a sequential tool remains sequential in parallel mode",async()=>{
    let active=0;
    let maxActive=0;
    const registry=new ToolRegistry();
    for(const [name,mode] of [["read-test","parallel"],["write-test","sequential"]] as const){
        registry.register({
            definition:{name,description:"test",parametersJson:'{"type":"object","properties":{}}'},mode,
            async execute(){
                active++;
                maxActive=Math.max(maxActive,active);
                await delay(10);
                active--;
                return {content:[{type:"text",text:"ok"}]};
            },
        });
    }
    let calls=0;
    const gateway:ModelGateway={
        async complete(){throw new Error("Unexpected compaction");},
        async *stream(){
            const result=response(calls++===0);
            if(result.termination.kind==="TOOL_CALLS"){
                yield {type:"done",response:{...result,message:{...result.message,content:[
                    {type:"tool_call",callId:"1",name:"read-test",argumentsJson:"{}"},
                    {type:"tool_call",callId:"2",name:"write-test",argumentsJson:"{}"},
                ]}}};
            }else yield {type:"done",response:result};
        },
    };
    const session=new AgentSession(new AgentLoop(gateway,registry));
    assert.equal((await session.prompt("test",{...base,ToolExecutionMode:"parallel"})).stopReason,"stop");
    assert.equal(maxActive,1);
});
