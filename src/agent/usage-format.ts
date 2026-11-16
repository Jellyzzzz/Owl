import type {UsageTotals} from "./usage.js";

/** Format only provider-reported session usage; context estimates are separate. */
export function formatSessionUsage(usage:UsageTotals,running=false):string{
    const count=(tokens:number,missing:number):string=>{
        const value=missing===usage.responses?"—":tokens.toLocaleString("en-US");
        return missing>0?`${value}（${missing} 次未报告）`:value;
    };
    const ratio=usage.cacheRatioInputTokens>0
        ?`${(usage.cacheRatioReadTokens/usage.cacheRatioInputTokens*100).toFixed(1)}%`
        :"—";
    const missingRatio=usage.responses-usage.cacheRatioResponses;
    const ratioNote=missingRatio>0&&usage.cacheRatioInputTokens>0
        ?`，${missingRatio} 次未计入比例`
        :"";
    const lines=[
        "Session usage（已报告）",
        `请求记录：${usage.responses} 次`,
        `累计输入：${count(usage.inputTokens,usage.missingInput)} tokens`,
        `  缓存命中：${count(usage.cachedReadTokens,usage.missingCachedRead)} tokens（${ratio}${ratioNote}）`,
        `  未缓存输入：${count(usage.uncachedTokens,usage.missingUncached)} tokens`,
    ];
    if(usage.missingCachedWrite<usage.responses){
        lines.push(`  缓存写入：${count(usage.cachedWriteTokens,usage.missingCachedWrite)} tokens`);
    }
    lines.push(
        `累计输出：${count(usage.outputTokens,usage.missingOutput)} tokens`,
        `累计总量：${count(usage.reportedTokens,usage.missingTotals)} tokens`,
    );
    if(running){
        lines.push("任务进行中；统计截至已结束的模型请求。");
    }
    return lines.join("\n");
}
