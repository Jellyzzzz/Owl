import {mkdtemp,readFile,rm,unlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {estimateMessageTokens,measureContext} from "../src/agent/context-budget.js";
import {loadSessionLog} from "../src/agent/session-log.js";
import {buildSystemPrompt} from "../src/agent/system-prompt.js";
import type{JsonValue,Message,Request,ToolCallBlock,ToolDefinition} from "../src/model/types.js";
import {readToolResult} from "../src/model/tool-result.js";
import {BashTool} from "../src/tools/bash.js";
import {EditTool} from "../src/tools/edit.js";
import {ReadTool} from "../src/tools/read.js";
import {ToolRegistry,type ToolExecutionResult} from "../src/tools/registry.js";
import {WriteTool} from "../src/tools/write.js";

const CONTEXT_WINDOW=1_000_000;
const MAX_OUTPUT_TOKENS=8192;
const RESERVE_TOKENS=16384;
const MODEL={providerId:"deepseek",modelId:"token-report"};

type Variant="actual"|"full"|"diff";
type Prepared={
    readonly label:string;
    readonly call:ToolCallBlock;
    readonly actual:Message;
    readonly full:Message;
    readonly diff:Message;
    readonly actualText:string;
    readonly fullText:string;
    readonly diffText:string;
};
type StageRow={
    readonly label:string;
    readonly actual:number;
    readonly full:number;
    readonly diff:number;
};

function tokens(text:string):number{
    return Math.ceil(Buffer.byteLength(text,"utf-8")/4);
}
function number(value:number):string{
    return value.toLocaleString("en-US");
}
function ratio(value:number):string{
    return `${(value*100).toFixed(1)}%`;
}
function pad(value:string,width:number):string{
    return value.length>=width?value:value+" ".repeat(width-value.length);
}
function userMessage(text:string):Message{
    return {role:"user",content:[{type:"text",text:text}],timestamp:Date.now()};
}
function assistantCall(call:ToolCallBlock):Message{
    return {role:"assistant",content:[call],timestamp:Date.now()};
}
function toolCall(callId:string,name:string,args:unknown):ToolCallBlock{
    return {
        type:"tool_call",
        callId:callId,
        name:name,
        argumentsJson:JSON.stringify(args),
    };
}
function toolText(message:Message):string{
    const {content}=readToolResult(message);
    return content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}
function replaceToolText(message:Message,text:string):Message{
    return {
        ...message,
        content:message.content.map(block=>block.type==="text"?{type:"text",text:text}:block),
    };
}
function objectValue(value:JsonValue|undefined,key:string):JsonValue|undefined{
    if(!value||typeof value!=="object"||Array.isArray(value)){
        return undefined;
    }
    return (value as {readonly [key:string]:JsonValue})[key];
}
function requestFor(messages:readonly Message[],tools:readonly ToolDefinition[],systemPrompt:string):Request{
    return {
        modelCallId:"token-report",
        model:MODEL,
        messages:messages,
        tools:tools,
        maxOutputTokens:MAX_OUTPUT_TOKENS,
        thinkingJson:"{}",
        systemPrompt:systemPrompt,
    };
}
function contextTokens(messages:readonly Message[],tools:readonly ToolDefinition[],systemPrompt:string):number{
    return measureContext(
        requestFor(messages,tools,systemPrompt),
        CONTEXT_WINDOW,
        RESERVE_TOKENS,
    ).estimatedInputTokens;
}

async function runBenchmark():Promise<void>{
    const cwd=await mkdtemp(join(tmpdir(),"owl-token-report-"));
    const registry=new ToolRegistry();
    registry.register(ReadTool);
    registry.register(EditTool);
    registry.register(WriteTool);
    registry.register(BashTool);
    const tools=registry.definitions();
    const systemPrompt=buildSystemPrompt(cwd);
    const padding="0123456789".repeat(12);
    const largeLines=Array.from({length:3000},(_,index)=>
        `export const value${index+1} = ${index+1}; // ${padding}`,
    );
    largeLines[0]=`export const alpha = 1; // ${padding}`;
    largeLines[99]=`export const beta = 2; // ${padding}`;
    largeLines[299]=`export const gamma = 3; // ${padding}`;
    const largeContent=largeLines.join("\n")+"\n";
    const largeFile=join(cwd,"large.ts");
    const generatedContent=Array.from({length:150},(_,index)=>
        `export const generated${index+1} = ${index+1}; // ${padding}`,
    ).join("\n")+"\n";
    const bashLine=padding;
    const bashCommand=`yes '${bashLine}' | head -n 5000`;
    const bashFullOutput=(bashLine+"\n").repeat(5000);
    const initialUser=userMessage("Inspect, edit, generate, and verify the project.");
    await writeFile(largeFile,largeContent,"utf-8");

    const prepared:Prepared[]=[];
    function record(
        label:string,call:ToolCallBlock,execution:ToolExecutionResult,
        fullText:string,diffText?:string,
    ):void{
        const actualText=toolText(execution.message);
        const diff=diffText??actualText;
        prepared.push({
            label:label,
            call:call,
            actual:execution.message,
            full:replaceToolText(execution.message,fullText),
            diff:replaceToolText(execution.message,diff),
            actualText:actualText,
            fullText:fullText,
            diffText:diff,
        });
    }
    function stageMessages(index:number,variant:Variant):Message[]{
        const messages:Message[]=[initialUser];
        for(let current=0;current<=index;current++){
            const item=prepared[current];
            messages.push(assistantCall(item.call),item[variant]);
        }
        return messages;
    }
    function stageRows():StageRow[]{
        const base:StageRow={
            label:"initial user",
            actual:contextTokens([initialUser],tools,systemPrompt),
            full:contextTokens([initialUser],tools,systemPrompt),
            diff:contextTokens([initialUser],tools,systemPrompt),
        };
        return [
            base,
            ...prepared.map((item,index)=>({
                label:item.label,
                actual:contextTokens(stageMessages(index,"actual"),tools,systemPrompt),
                full:contextTokens(stageMessages(index,"full"),tools,systemPrompt),
                diff:contextTokens(stageMessages(index,"diff"),tools,systemPrompt),
            })),
        ];
    }

    try{
        const readCall=toolCall("read-1","read",{path:"large.ts"});
        const readExecution=await registry.execute(readCall,cwd,new AbortController().signal);
        record("read large.ts",readCall,readExecution,largeContent);

        const editCall=toolCall("edit-1","edit",{
            path:"large.ts",
            edits:[
                {oldText:"export const alpha = 1;",newText:"export const alpha = 101;"},
                {oldText:"export const beta = 2;",newText:"export const beta = 202;"},
                {oldText:"export const gamma = 3;",newText:"export const gamma = 303;"},
            ],
        });
        const editExecution=await registry.execute(editCall,cwd,new AbortController().signal);
        const editedContent=await readFile(largeFile,"utf-8");
        const editDiff=objectValue(editExecution.details,"diff");
        record(
            "edit large.ts (3 blocks)",
            editCall,
            editExecution,
            editedContent,
            typeof editDiff==="string"?editDiff:undefined,
        );

        const writeCall=toolCall("write-1","write",{
            path:"generated.ts",
            content:generatedContent,
        });
        const writeExecution=await registry.execute(writeCall,cwd,new AbortController().signal);
        record("write generated.ts",writeCall,writeExecution,generatedContent);

        const bashCall=toolCall("bash-1","bash",{command:bashCommand,timeout:10});
        const bashExecution=await registry.execute(bashCall,cwd,new AbortController().signal);
        record("bash 5000 lines",bashCall,bashExecution,bashFullOutput);
        const outputPath=objectValue(bashExecution.details,"fullOutputPath");
        if(typeof outputPath==="string"){
            await unlink(outputPath).catch(()=>{});
        }

        const perTool=tools.map(tool=>{
            const bytes=Buffer.byteLength(tool.name)
                +Buffer.byteLength(tool.description)
                +Buffer.byteLength(tool.parametersJson);
            return {name:tool.name,bytes:bytes,tokens:Math.ceil(bytes/4)};
        });
        const fixedWithTools=contextTokens([],tools,systemPrompt);
        const fixedWithoutTools=contextTokens([],[],systemPrompt);
        const perCallToolOverhead=fixedWithTools-fixedWithoutTools;
        const rows=stageRows();
        const cumulative=rows.reduce(
            (total,row)=>({
                actual:total.actual+row.actual,
                full:total.full+row.full,
                diff:total.diff+row.diff,
            }),
            {actual:0,full:0,diff:0},
        );
        const savedFull=cumulative.full===0?0:1-cumulative.actual/cumulative.full;

        console.log("Owl 工具上下文 token 观测");
        console.log(`估算规则：UTF-8 字节 / 4；contextWindow=${number(CONTEXT_WINDOW)}，reserve=${number(RESERVE_TOKENS)}`);
        console.log("场景：read 3,000 行文件（实际截断）→ edit 3 处 → write 150 行文件 → bash 5,000 行输出");
        console.log(`固定开销：system prompt ${number(fixedWithoutTools)} tokens；4 个工具定义另加 ${number(perCallToolOverhead)} tokens/次请求`);
        console.log("");
        console.log("1) 工具定义（每次模型请求都会重新发送）");
        console.log(`${pad("tool",10)}${pad("bytes",12)}${pad("tokens",12)}`);
        for(const row of perTool){
            console.log(`${pad(row.name,10)}${pad(number(row.bytes),12)}${pad(number(row.tokens),12)}`);
        }
        console.log(`${pad("total",10)}${pad(number(perTool.reduce((sum,row)=>sum+row.bytes,0)),12)}${pad(number(perTool.reduce((sum,row)=>sum+row.tokens,0)),12)}`);
        console.log("");

        console.log("2) 单次工具调用：参数 + 模型可见结果 vs 全量回传结果");
        console.log(`${pad("tool",26)}${pad("args",10)}${pad("actual",12)}${pad("full",12)}${pad("diff",10)}${pad("saved",10)}`);
        for(const row of prepared){
            const saved=row.fullText.length===0?0:1-row.actualText.length/row.fullText.length;
            console.log(
                `${pad(row.label,26)}${pad(number(tokens(row.call.argumentsJson)),10)}${pad(number(tokens(row.actualText)),12)}${pad(number(tokens(row.fullText)),12)}${pad(row.diffText===row.actualText?"-":number(tokens(row.diffText)),10)}${pad(ratio(saved),10)}`,
            );
        }
        console.log("说明：args 是模型生成工具参数的成本（write 的正文在这里，无法省略）；actual 是工具真正写入 tool message 的文本；full 是把完整文件/完整输出塞回模型的反事实；diff 仅对 edit 有意义。");
        console.log("");

        console.log("3) 整个 run 的累计上下文成本（5 次模型请求的输入之和）");
        console.log(`${pad("stage",26)}${pad("actual",12)}${pad("full",12)}${pad("diff",12)}`);
        for(const row of rows){
            console.log(`${pad(row.label,26)}${pad(number(row.actual),12)}${pad(number(row.full),12)}${pad(number(row.diff),12)}`);
        }
        console.log(`${pad("累计 input",26)}${pad(number(cumulative.actual),12)}${pad(number(cumulative.full),12)}${pad(number(cumulative.diff),12)}`);
        console.log(`实际结果相对全量回传节省：${number(cumulative.full-cumulative.actual)} tokens（${ratio(savedFull)}）`);
        console.log("说明：工具结果会保留在后续所有请求里，所以累计节省 = 单次节省 × 后续请求次数。");
        console.log("");
        console.log("4) 每个工具对整个 run 的累计上下文成本");
        console.log(`${pad("tool",26)}${pad("args",10)}${pad("result",10)}${pad("per req",10)}${pad("reqs",6)}${pad("actual",12)}${pad("full",12)}`);
        for(let index=0;index<prepared.length;index++){
            const item=prepared[index];
            const previous=rows[index];
            const current=rows[index+1];
            const requests=rows.length-(index+1);
            const perRequest=current.actual-previous.actual;
            const perRequestFull=current.full-previous.full;
            console.log(
                `${pad(item.label,26)}${pad(number(tokens(item.call.argumentsJson)),10)}${pad(number(tokens(item.actualText)),10)}${pad(number(perRequest),10)}${pad(number(requests),6)}${pad(number(perRequest*requests),12)}${pad(number(perRequestFull*requests),12)}`,
            );
        }
        console.log("说明：per req 是“工具调用参数 + 工具结果 + 消息元数据”进入上下文后的单次增量；reqs 是该结果还会出现在后续多少次请求中；actual/full 是乘上 reqs 后的累计成本。");
        console.log("");
        console.log("5) 结论");
        console.log("- read/bash 通过截断把超大输出压到固定上限，避免一次性把整份文件或命令输出写入上下文。");
        console.log("- edit/write 只返回一行状态，diff/patch/content 留在 details，不进入模型上下文；但 write 的正文本身仍是工具参数的上下文成本。");
        console.log("- 应看整个 run 的请求输入之和，而不是只看单次 tool result；结果保留得越久，单次节省的累计收益越大。");
    }finally{
        await rm(cwd,{recursive:true,force:true});
    }
}

async function analyzeSession(path:string):Promise<void>{
    const loaded=await loadSessionLog(path,true);
    type Row={calls:number;callArgs:number;results:number;resultMessages:number};
    const byTool=new Map<string,Row>();
    const rowFor=(name:string):Row=>{
        let row=byTool.get(name);
        if(row===undefined){
            row={calls:0,callArgs:0,results:0,resultMessages:0};
            byTool.set(name,row);
        }
        return row;
    };
    let messageTokens=0;
    let toolResultTokens=0;
    let toolCallTokens=0;
    for(const message of loaded.messages){
        messageTokens+=estimateMessageTokens(message);
        if(message.role==="tool"){
            const {result,content}=readToolResult(message);
            const text=content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
            const row=rowFor(result.name);
            row.calls++;
            row.results+=tokens(text);
            row.resultMessages+=estimateMessageTokens(message);
            toolResultTokens+=tokens(text);
        }else if(message.role==="assistant"){
            for(const block of message.content){
                if(block.type!=="tool_call") continue;
                const row=rowFor(block.name);
                row.callArgs+=tokens(block.argumentsJson);
                toolCallTokens+=tokens(block.argumentsJson);
            }
        }
    }
    console.log(`Session: ${path}`);
    console.log(`messages=${number(loaded.messages.length)}  estimated message tokens=${number(messageTokens)}`);
    console.log(`provider usage: reported=${number(loaded.usageTotals.reportedTokens)} responses=${number(loaded.usageTotals.responses)} missing=${number(loaded.usageTotals.missingTotals)}`);
    console.log(`tool call arguments=${number(toolCallTokens)} tokens; tool result text=${number(toolResultTokens)} tokens`);
    console.log("");
    console.log(`${pad("tool",10)}${pad("calls",8)}${pad("args",12)}${pad("result",12)}${pad("msg",12)}`);
    for(const [name,row] of byTool){
        console.log(`${pad(name,10)}${pad(number(row.calls),8)}${pad(number(row.callArgs),12)}${pad(number(row.results),12)}${pad(number(row.resultMessages),12)}`);
    }
    console.log("");
    console.log("说明：args 是模型生成工具参数的成本；result 是工具回传到上下文的文本成本；msg 含 role/name/callId 等消息开销。");
}

const args=process.argv.slice(2);
const sessionFlag=args.indexOf("--session");
if(sessionFlag>=0){
    const path=args[sessionFlag+1];
    if(!path){
        console.error("用法: npm run token:report -- --session <session.jsonl>");
        process.exitCode=1;
    }else{
        await analyzeSession(path);
    }
}else{
    await runBenchmark();
}
