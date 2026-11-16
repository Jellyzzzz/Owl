import type{Usage} from "../model/types.js";
export type UsageTotals={
    readonly reportedTokens:number;
    readonly responses:number;
    readonly missingTotals:number;
    readonly uncachedTokens:number;
    readonly cachedReadTokens:number;
    readonly cachedWriteTokens:number;
    /** Alias of reportedTokens, retained alongside the existing status-bar field. */
    readonly totalTokens:number;
    readonly inputTokens:number;
    readonly outputTokens:number;
    readonly reasoningTokens:number;
    readonly missingInput:number;
    readonly missingUncached:number;
    readonly missingCachedRead:number;
    readonly missingCachedWrite:number;
    readonly missingOutput:number;
    readonly missingReasoning:number;
    /** Only requests with both input and cache-read counts contribute to this ratio. */
    readonly cacheRatioInputTokens:number;
    readonly cacheRatioReadTokens:number;
    readonly cacheRatioResponses:number;
}
export function createUsageTotals():UsageTotals{
    return {
        reportedTokens:0,responses:0,missingTotals:0,
        uncachedTokens:0,cachedReadTokens:0,cachedWriteTokens:0,totalTokens:0,
        inputTokens:0,outputTokens:0,reasoningTokens:0,
        missingInput:0,missingUncached:0,missingCachedRead:0,missingCachedWrite:0,
        missingOutput:0,missingReasoning:0,
        cacheRatioInputTokens:0,cacheRatioReadTokens:0,cacheRatioResponses:0,
    };
}
export function addUsageTotals(totals:UsageTotals,usage:Usage|null):UsageTotals{
    const total=usage?.totalTokens??null;
    const uncached=usage?.inputTokens??null;
    const cachedRead=usage?.cachedReadTokens??null;
    const cachedWrite=usage?.cachedWriteTokens??null;
    const output=usage?.outputTokens??null;
    const reasoning=usage?.reasoningTokens??null;
    // Pi's normalized input excludes cache reads and separately reported writes.
    // Prefer the reported total minus output when individual input fields are absent.
    const input=total!==null&&output!==null&&total>=output
        ?total-output
        :uncached!==null&&cachedRead!==null&&cachedWrite!==null
            ?uncached+cachedRead+cachedWrite
            :null;
    const canCalculateCacheRatio=input!==null&&cachedRead!==null&&cachedRead<=input;
    const reportedTokens=totals.reportedTokens+(total??0);
    return {
        reportedTokens,
        totalTokens:reportedTokens,
        responses:totals.responses+1,
        missingTotals:totals.missingTotals+(total===null?1:0),
        uncachedTokens:totals.uncachedTokens+(uncached??0),
        cachedReadTokens:totals.cachedReadTokens+(cachedRead??0),
        cachedWriteTokens:totals.cachedWriteTokens+(cachedWrite??0),
        inputTokens:totals.inputTokens+(input??0),
        outputTokens:totals.outputTokens+(output??0),
        reasoningTokens:totals.reasoningTokens+(reasoning??0),
        missingInput:totals.missingInput+(input===null?1:0),
        missingUncached:totals.missingUncached+(uncached===null?1:0),
        missingCachedRead:totals.missingCachedRead+(cachedRead===null?1:0),
        missingCachedWrite:totals.missingCachedWrite+(cachedWrite===null?1:0),
        missingOutput:totals.missingOutput+(output===null?1:0),
        missingReasoning:totals.missingReasoning+(reasoning===null?1:0),
        cacheRatioInputTokens:totals.cacheRatioInputTokens+(canCalculateCacheRatio?input:0),
        cacheRatioReadTokens:totals.cacheRatioReadTokens+(canCalculateCacheRatio?cachedRead:0),
        cacheRatioResponses:totals.cacheRatioResponses+(canCalculateCacheRatio?1:0),
    };
}
