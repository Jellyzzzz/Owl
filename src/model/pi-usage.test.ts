import {test} from "node:test";
import assert from "node:assert/strict";
import {readOpenAIStreamUsage} from "./pi-usage.js";

test("reads DeepSeek cache hits as part of prompt tokens without double counting",()=>{
    assert.deepEqual(readOpenAIStreamUsage({usage:{
        prompt_tokens:100,completion_tokens:20,total_tokens:120,
        prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40,
    }}),{
        inputTokens:40,outputTokens:20,totalTokens:120,
        cachedReadTokens:60,cachedWriteTokens:null,reasoningTokens:null,
    });
});

test("distinguishes an actual zero from missing usage and missing fields",()=>{
    assert.equal(readOpenAIStreamUsage({usage:null}),undefined);
    assert.deepEqual(readOpenAIStreamUsage({usage:{
        prompt_tokens:10,completion_tokens:0,total_tokens:10,
        prompt_tokens_details:{cached_tokens:0},
    }}),{
        inputTokens:10,outputTokens:0,totalTokens:10,
        cachedReadTokens:0,cachedWriteTokens:null,reasoningTokens:null,
    });
    assert.deepEqual(readOpenAIStreamUsage({usage:{prompt_tokens:10,completion_tokens:4}}),{
        inputTokens:null,outputTokens:4,totalTokens:null,
        cachedReadTokens:null,cachedWriteTokens:null,reasoningTokens:null,
    });
});

test("subtracts separately reported cache writes and supports nested usage",()=>{
    assert.deepEqual(readOpenAIStreamUsage({choices:[{usage:{
        prompt_tokens:100,completion_tokens:9,total_tokens:109,
        prompt_tokens_details:{cached_tokens:50,cache_write_tokens:20},
        completion_tokens_details:{reasoning_tokens:3},
    }}]}),{
        inputTokens:30,outputTokens:9,totalTokens:109,
        cachedReadTokens:50,cachedWriteTokens:20,reasoningTokens:3,
    });
});
