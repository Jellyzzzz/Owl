import type {Usage} from "./types.js";

function record(value:unknown):Record<string,unknown>|undefined{
    return typeof value==="object"&&value!==null&&!Array.isArray(value)
        ?value as Record<string,unknown>
        :undefined;
}
function count(value:unknown):number|null{
    return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;
}

/** Read OpenAI-compatible raw usage before Pi substitutes zero for absent fields. */
export function readOpenAIStreamUsage(event:unknown):Usage|undefined{
    const chunk=record(event);
    const choices=Array.isArray(chunk?.choices)?chunk.choices:[];
    const raw=record(chunk?.usage)??record(record(choices[0])?.usage);
    if(raw===undefined) return undefined;

    const prompt=count(raw.prompt_tokens);
    const promptDetails=record(raw.prompt_tokens_details);
    const completionDetails=record(raw.completion_tokens_details);
    const cachedRead=count(promptDetails?.cached_tokens)
        ??count(raw.prompt_cache_hit_tokens)
        ??count(raw.cached_tokens);
    const cachedWrite=count(promptDetails?.cache_write_tokens);
    // An unreported cache-write field is included in the remainder, following
    // Pi's OpenAI-compatible normalization; it is not reported as a known zero.
    const excluded=(cachedRead??0)+(cachedWrite??0);
    const uncached=prompt!==null&&cachedRead!==null&&prompt>=excluded
        ?prompt-excluded
        :null;
    return {
        inputTokens:uncached,
        outputTokens:count(raw.completion_tokens),
        totalTokens:count(raw.total_tokens),
        cachedReadTokens:cachedRead,
        cachedWriteTokens:cachedWrite,
        reasoningTokens:count(completionDetails?.reasoning_tokens),
    };
}
