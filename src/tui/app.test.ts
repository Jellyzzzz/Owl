import {test} from "node:test";
import assert from "node:assert/strict";
import {OwlTui} from "./app.js";
import {createUsageTotals} from "../agent/usage.js";

test("usage can be inspected during a run while ordinary input remains queued",async()=>{
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    const submitted:string[]=[];
    const ui=new OwlTui({
        cwd:"/",modelId:"test",contextWindow:1000,
        runtimeSettings:()=>({reasoningLevel:"high",toolMode:"sequential"}),
        runUsage:createUsageTotals,sessionUsage:createUsageTotals,
        onSubmit:async text=>{
            submitted.push(text);
            if(text==="task") await pending;
        },
        onInterrupt:()=>false,onExit:()=>{},
    });
    ui.requestRender=()=>{};
    const dispatch=(ui as unknown as {dispatch:(text:string)=>Promise<void>}).dispatch.bind(ui);
    const running=dispatch("task");
    await dispatch("/usage");
    await dispatch("follow-up");
    assert.deepEqual(submitted,["task","/usage"]);
    finish();
    await running;
    assert.deepEqual(submitted,["task","/usage","follow-up"]);
});
