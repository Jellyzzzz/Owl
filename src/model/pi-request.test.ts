import {test} from "node:test";
import assert from "node:assert/strict";
import {createModels,getSupportedThinkingLevels} from "@earendil-works/pi-ai";
import {deepseekProvider} from "@earendil-works/pi-ai/providers/deepseek";
import {toPiContext,toPiOptions} from "./pi-request.js";
import type {Request} from "./types.js";

test("DeepSeek reasoning choices and output limit reach the provider payload",async()=>{
    const models=createModels();
    models.setProvider(deepseekProvider());
    const model=models.getModel("deepseek","deepseek-flash");
    assert.ok(model);
    assert.deepEqual(getSupportedThinkingLevels(model),["off","low","high","max"]);
    for(const level of ["off","low","high","max"] as const){
        const request:Request={
            modelCallId:"test",model:{providerId:"deepseek",modelId:model.id},
            messages:[{role:"user",content:[{type:"text",text:"test"}],timestamp:1}],tools:[],
            maxOutputTokens:32768,thinkingJson:level==="off"?"{}":JSON.stringify({reasoning:level}),
        };
        const options=toPiOptions(request,new AbortController().signal);
        options.apiKey="stub";
        let payload:Record<string,unknown>|undefined;
        options.onPayload=value=>{
            payload=value as Record<string,unknown>;
            // Stop before the SDK creates an HTTP request.
            throw new Error("captured payload");
        };
        for await(const _event of models.streamSimple(model,toPiContext(request),options)){}
        assert.ok(payload);
        assert.deepEqual(payload.thinking,{type:level==="off"?"disabled":"enabled"});
        assert.equal(payload.reasoning_effort,level==="off"?undefined:level);
        assert.equal(payload.max_tokens,32768);
    }
});
