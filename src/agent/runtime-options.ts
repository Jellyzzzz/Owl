import type {ModelThinkingLevel} from "@earendil-works/pi-ai";
import type {LoopOptions} from "./types.js";
import type {ToolExecutionMode} from "../tools/types.js";

export type RuntimeOptionsUpdate={
    readonly reasoningLevel?:ModelThinkingLevel;
    readonly maxOutputTokens?:number;
    readonly maxModelCalls?:number;
    readonly maxConcurrentTools?:number;
    readonly toolExecutionMode?:ToolExecutionMode;
};

/** Stores immutable per-run option snapshots; updates affect subsequent runs. */
export class RuntimeOptions{
    private current:LoopOptions;
    private level:ModelThinkingLevel;
    readonly supportedReasoningLevels:readonly ModelThinkingLevel[];
    readonly maxOutputTokensLimit:number;
    private readonly compactAt?:number;

    constructor(
        initial:LoopOptions,
        reasoningLevel:ModelThinkingLevel,
        supportedReasoningLevels:readonly ModelThinkingLevel[],
        modelMaxOutputTokens:number,
        compactAt?:number,
    ){
        this.current=initial;
        this.level=reasoningLevel;
        this.supportedReasoningLevels=[...supportedReasoningLevels];
        this.maxOutputTokensLimit=Math.min(modelMaxOutputTokens,initial.contextWindow-1);
        this.compactAt=compactAt;
        this.set({reasoningLevel,maxOutputTokens:initial.maxOutputTokens});
    }

    get():LoopOptions{
        return this.current;
    }

    get reasoningLevel():ModelThinkingLevel{
        return this.level;
    }

    set(update:RuntimeOptionsUpdate):LoopOptions{
        const nextLevel=update.reasoningLevel??this.level;
        if(!this.supportedReasoningLevels.includes(nextLevel)){
            throw new Error(`不支持推理等级 ${nextLevel}。可选：${this.supportedReasoningLevels.join(", ")}`);
        }
        const maxOutputTokens=update.maxOutputTokens??this.current.maxOutputTokens;
        const maxModelCalls=update.maxModelCalls??this.current.maxModelCalls;
        const maxConcurrentTools=update.maxConcurrentTools??this.current.maxConcurrentTools;
        const toolExecutionMode=update.toolExecutionMode??this.current.ToolExecutionMode;
        if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>this.maxOutputTokensLimit){
            throw new Error(`输出上限必须为 1 到 ${this.maxOutputTokensLimit} 的整数`);
        }
        if(!Number.isSafeInteger(maxModelCalls)||maxModelCalls<1){
            throw new Error("模型调用上限必须为正整数");
        }
        if(!Number.isSafeInteger(maxConcurrentTools)||maxConcurrentTools<1){
            throw new Error("工具并发上限必须为正整数");
        }
        if(toolExecutionMode!=="parallel"&&toolExecutionMode!=="sequential"){
            throw new Error("工具执行模式必须为 parallel 或 sequential");
        }
        const reserveTokens=this.compactAt===undefined
            ?Math.max(maxOutputTokens,Math.min(16384,this.current.contextWindow-1))
            :this.current.contextWindow-this.compactAt;
        if(!Number.isSafeInteger(reserveTokens)||reserveTokens<maxOutputTokens||reserveTokens>=this.current.contextWindow){
            throw new Error(`输出上限与压缩阈值不兼容，最多可设为 ${reserveTokens} tokens`);
        }
        const next:LoopOptions={
            ...this.current,
            thinkingJson:nextLevel==="off"?"{}":JSON.stringify({reasoning:nextLevel}),
            maxOutputTokens,maxModelCalls,maxConcurrentTools,reserveTokens,
            ToolExecutionMode:toolExecutionMode,
        };
        this.level=nextLevel;
        this.current=next;
        return next;
    }
}
