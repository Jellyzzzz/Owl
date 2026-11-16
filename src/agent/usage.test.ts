import {test} from "node:test";
import assert from "node:assert/strict";
import type {Usage} from "../model/types.js";
import {addUsageTotals,createUsageTotals} from "./usage.js";
import {formatSessionUsage} from "./usage-format.js";

const usage=(inputTokens:number,cachedReadTokens:number,outputTokens:number):Usage=>({
    inputTokens,cachedReadTokens,outputTokens,cachedWriteTokens:0,reasoningTokens:0,
    totalTokens:inputTokens+cachedReadTokens+outputTokens,
});

test("session usage sums input, output and cache hits and weights the cache ratio by tokens",()=>{
    let totals=createUsageTotals();
    totals=addUsageTotals(totals,usage(900,100,20));
    totals=addUsageTotals(totals,usage(0,100,10));
    assert.equal(totals.inputTokens,1100);
    assert.equal(totals.uncachedTokens,900);
    assert.equal(totals.cachedReadTokens,200);
    assert.equal(totals.outputTokens,30);
    assert.equal(totals.reportedTokens,1130);
    assert.equal(totals.totalTokens,1130);
    assert.equal(totals.responses,2);
    // The two request rates are 10% and 100%, but their combined rate is 18.2%.
    assert.match(formatSessionUsage(totals),/缓存命中：200 tokens（18\.2%）/);
});

test("missing usage is not treated as zero and is excluded from the cache ratio",()=>{
    let totals=addUsageTotals(createUsageTotals(),usage(40,60,20));
    totals=addUsageTotals(totals,null);
    totals=addUsageTotals(totals,{
        inputTokens:null,cachedReadTokens:null,cachedWriteTokens:null,
        outputTokens:10,totalTokens:30,reasoningTokens:null,
    });
    assert.equal(totals.inputTokens,120);
    assert.equal(totals.outputTokens,30);
    assert.equal(totals.missingTotals,1);
    assert.equal(totals.cacheRatioResponses,1);
    const display=formatSessionUsage(totals,true);
    assert.match(display,/累计输入：120（1 次未报告）/);
    assert.match(display,/缓存命中：60（2 次未报告） tokens（60\.0%，2 次未计入比例）/);
    assert.match(display,/累计总量：150（1 次未报告）/);
    assert.match(display,/任务进行中/);
});

test("empty usage and zero input display no cache percentage",()=>{
    assert.match(formatSessionUsage(createUsageTotals()),/缓存命中：— tokens（—）/);
    const totals=addUsageTotals(createUsageTotals(),usage(0,0,12));
    assert.match(formatSessionUsage(totals),/缓存命中：0 tokens（—）/);
});
