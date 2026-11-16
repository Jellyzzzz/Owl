import {createHash,randomUUID} from "node:crypto";
import {stat} from "node:fs/promises";
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {parseArgs} from "node:util";
import {createModels,getSupportedThinkingLevels,type ModelThinkingLevel}from "@earendil-works/pi-ai";
import {deepseekProvider}from "@earendil-works/pi-ai/providers/deepseek";
import {PiGateway}from "./model/pi-gateway.js";
import type{Message}from "./model/types.js";
import {ToolRegistry} from "./tools/registry.js";
import {ReadTool} from "./tools/read.js";
import {EditTool} from "./tools/edit.js";
import {WriteTool} from "./tools/write.js";
import {GrepTool} from "./tools/grep.js";
import {FindTool} from "./tools/find.js";
import {BashTool} from "./tools/bash.js";
import {AgentLoop} from "./agent/loop.js";
import {AgentSession} from "./agent/session.js";
import {
    appendSessionEntry,appendSessionMessage,appendSessionUsage,listSessions,
    loadSessionLog,restoreContextUsageAnchor,type LoadedSession,
} from "./agent/session-log.js";
import {createUsageTotals} from "./agent/usage.js";
import {formatSessionUsage} from "./agent/usage-format.js";
import {RuntimeOptions,type RuntimeOptionsUpdate} from "./agent/runtime-options.js";
import {buildSystemPrompt} from "./agent/system-prompt.js";
import type{AgentEvent,LoopOptions} from "./agent/types.js";
import {OwlTui} from "./tui/app.js";
import {formatTokens} from "./tui/transcript.js";
import type{SelectItem} from "@earendil-works/pi-tui";

const SESSION_ID_PATTERN=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LOCAL_COMMANDS={
    "/resume":"恢复会话",
    "/compact":"压缩上下文，可附加摘要要求",
    "/usage":"查看会话 token 用量",
    "/settings":"查看和选择运行设置",
    "/reasoning":"选择推理等级",
    "/max-output":"设置单次输出 token 上限",
    "/max-calls":"设置每次任务的模型调用上限",
    "/concurrency":"设置工具并发上限",
    "/parallel":"启用并行工具调用",
    "/sequential":"启用顺序工具调用",
    "/help":"查看命令",
    "/exit":"退出 Owl",
};

type SessionDirs={
    readonly current:string;
    readonly legacyProject:string;
    readonly legacyRoot:string;
};
type SettingKey="reasoning"|"max-output"|"max-calls"|"concurrency"|"tool-mode";
const VALUE_COMMANDS=new Set(["/reasoning","/max-output","/max-calls","/concurrency"]);

function showCommands():void{
    for(const [name,description] of Object.entries(LOCAL_COMMANDS)){
        console.log(`${name.padEnd(14)}${description}`);
    }
}

function commandsText():string{
    return Object.entries(LOCAL_COMMANDS)
        .map(([name,description])=>`${name.padEnd(14)}${description}`)
        .join("\n");
}

function positiveInteger(value:string|undefined,fallback:number,label:string):number{
    if(value===undefined) return fallback;
    const parsed=Number(value);
    if(value.trim()===""||!Number.isSafeInteger(parsed)||parsed<1){
        throw new Error(`${label} 必须为正整数`);
    }
    return parsed;
}

function showHome(cwd:string):void{
    console.log(`\nOwl  ·  ${cwd}\n`);
    console.log("输入消息开始新会话。\n");
    showCommands();
    console.log();
}

function renderHistory(messages:readonly Message[]):void{
    for(const message of messages){
        if(message.role!=="user"&&message.role!=="assistant") continue;

        const parts:string[]=[];
        for(const block of message.content){
            if(block?.type==="text"&&typeof block.text==="string") parts.push(block.text);
        }
        const text=parts.join("\n");
        if(!text.trim()) continue;

        const display=message.role==="user"
            ?text.split("\n").map(line=>"> "+line).join("\n")
            :text;
        console.log(display+"\n");
    }
}

async function pickSession(dirs:SessionDirs,lines:AsyncIterator<string>):Promise<string|undefined>{
    const [current,legacyProject,legacyFlat]=await Promise.all([
        listSessions(dirs.current),
        listSessions(dirs.legacyProject),
        listSessions(dirs.legacyRoot),
    ]);
    const projectSessions=[...current,...legacyProject].sort((a,b)=>b.mtimeMs-a.mtimeMs);
    const sessions=[...projectSessions,...legacyFlat];
    if(sessions.length===0){
        console.log("当前工作目录还没有已保存的会话。");
        return;
    }

    for(const [index,session] of sessions.entries()){
        // if(index===projectSessions.length) console.log("旧会话 · 未记录工作目录");
        const time=new Date(session.mtimeMs).toLocaleString();
        console.log(`${index+1}. ${session.id}  ${time}`);
    }

    while(true){
        const line=await lines.next();
        if(line.done||line.value.trim()==="") return;

        const number=Number(line.value);
        const selected=sessions[number-1];
        if(Number.isInteger(number)&&selected!==undefined) return selected.path;
        console.log("编号无效，请重新输入。");
    }
}

async function findSessionById(id:string,dirs:SessionDirs):Promise<string>{
    const name=`${id.toLowerCase()}.jsonl`;
    for(const dir of [dirs.current,dirs.legacyProject,dirs.legacyRoot]){
        const path=join(dir,name);
        const info=await stat(path).catch((error:unknown)=>{
            if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="ENOENT"){
                return undefined;
            }
            throw error;
        });
        if(info?.isFile()) return path;
    }
    throw new Error(`Session file not found: ${id}`);
}

async function main():Promise<void>{
    const apiKey=process.env.DEEPSEEK_API_KEY;
    const configuredModelId=process.env.DEEPSEEK_MODEL;
    const thinkingMode=process.env.DEEPSEEK_THINKING_MODE;

    if(!apiKey){
        throw new Error("Missing DEEPSEEK_API_KEY");
    }
    if(!configuredModelId){
        throw new Error("Missing DEEPSEEK_MODEL");
    }
    const modelId:string=configuredModelId;
    if(thinkingMode!==undefined&&thinkingMode!=="enabled"&&thinkingMode!=="disabled"){
        throw new Error("DEEPSEEK_THINKING_MODE must be enabled or disabled");
    }

    // 创建模型入口，并注册本次使用的 provider
    const models=createModels();
    models.setProvider(deepseekProvider());

    const model=models.getModel("deepseek",modelId);
    if(model===undefined){
        const available=models.getModels("deepseek")
            .map(model=>model.id)
            .join(", ");
        throw new Error(
            `Unknown model "${modelId}". Available: ${available}`
        );
    }

    const {values,positionals:args}=parseArgs({
        options:{
            session:{type:"string"},
            resume:{type:"boolean",default:false},
            "parallel-tools":{type:"boolean",default:false},
            "sequential-tools":{type:"boolean",default:false},
            reasoning:{type:"string"},
            "max-output-tokens":{type:"string"},
            "max-model-calls":{type:"string"},
            "max-concurrent-tools":{type:"string"},
            "compact-at":{type:"string"},
            tui:{type:"boolean",default:false},
            "no-tui":{type:"boolean",default:false},
        },
        allowPositionals:true,
    });
    if(values.session===""){
        throw new Error("--session requires a file path or session ID");
    }
    if(values.resume&&values.session!==undefined){
        throw new Error("Choose either --resume or --session");
    }
    if(values["parallel-tools"]&&values["sequential-tools"]){
        throw new Error("Choose either --parallel-tools or --sequential-tools");
    }
    const reasoningLevel=(values.reasoning??process.env.OWL_REASONING_LEVEL??
        (thinkingMode==="disabled"?"off":"high")) as ModelThinkingLevel;
    const supportedReasoningLevels=getSupportedThinkingLevels(model);
    const maxOutputTokens=positiveInteger(
        values["max-output-tokens"]??process.env.OWL_MAX_OUTPUT_TOKENS,
        Math.min(32768,model.maxTokens,model.contextWindow-1),"输出上限",
    );
    const maxModelCalls=positiveInteger(values["max-model-calls"]??process.env.OWL_MAX_MODEL_CALLS,100,"模型调用上限");
    const maxConcurrentTools=positiveInteger(values["max-concurrent-tools"]??process.env.OWL_MAX_CONCURRENT_TOOLS,5,"工具并发上限");
    const maxInputTokens=model.contextWindow-maxOutputTokens;
    const compactAt=values["compact-at"]===undefined?undefined:Number(values["compact-at"]);
    if(compactAt!==undefined&&(!Number.isSafeInteger(compactAt)||compactAt<1||compactAt>maxInputTokens)){
        throw new Error(`--compact-at requires an integer from 1 to ${maxInputTokens}`);
    }
    const configuredToolMode=values["parallel-tools"]?"parallel":values["sequential-tools"]?"sequential":
        (process.env.OWL_TOOL_EXECUTION_MODE??"sequential");
    if(configuredToolMode!=="parallel"&&configuredToolMode!=="sequential"){
        throw new Error("OWL_TOOL_EXECUTION_MODE must be parallel or sequential");
    }

    // 将已装配的模型入口交给 Gateway
    const gateway=new PiGateway(models);
    const registry=new ToolRegistry();
    registry.register(ReadTool);
    registry.register(EditTool);
    registry.register(WriteTool);
    registry.register(GrepTool);
    registry.register(FindTool);
    registry.register({
        ...BashTool,
        mode:"parallel",
        definition:{
            ...BashTool.definition,
            description:BashTool.definition.description+
                " When parallel execution is enabled, calls in the same response may run concurrently. Group independent read-only commands in one response. Run writes and dependent commands in separate responses.",
        },
    });
    const loop=new AgentLoop(gateway,registry);

    const cwd=process.cwd();
    const cwdKey=createHash("sha256").update(cwd).digest("hex");
    const legacyRoot=join(homedir(),".gitnova","sessions");
    const sessionDirs:SessionDirs={
        current:join(homedir(),".owl","sessions",cwdKey),
        legacyProject:join(legacyRoot,cwdKey),
        legacyRoot,
    };
    let activeSession:AgentSession|undefined;
    let activeSessionPath:string|undefined;
    let unsubscribe:(()=>void)|undefined;
    let persistenceError:Error|undefined;
    let tui:OwlTui|undefined;
    let tuiMode=false;

    function activateSession(
    filePath:string,
    loaded:LoadedSession={messages:[],usageTotals:createUsageTotals()},
):AgentSession{
    const {messages,usageTotals,checkpoint}=loaded;

    async function persist(operation:Promise<void>):Promise<void>{
        try{
            await operation;
        }catch(error:unknown){
            const detail=error instanceof Error?error.message:String(error);
            persistenceError=new Error(`无法保存会话 ${filePath}：${detail}`,{cause:error});
            throw persistenceError;
        }
    }

    const session=new AgentSession(
        loop,
        messages,
        message=>persist(appendSessionMessage(filePath,message)),
        {
            initialTotals:usageTotals,
            initialCheckpoint:checkpoint,
            initialContextAnchor:restoreContextUsageAnchor(loaded,{
                model:runtimeOptions.get().model,systemPrompt:runtimeOptions.get().systemPrompt,tools:registry.definitions(),
            }),
            persistCompaction:record=>persist(appendSessionEntry(filePath,record)),
            persist:(modelCallId,usage,purpose)=>
                persist(appendSessionUsage(filePath,modelCallId,usage,purpose)),
        },
    );

    unsubscribe?.();
    persistenceError=undefined;
    activeSession=session;
    activeSessionPath=filePath;
    unsubscribe=session.subscribe(event=>onAgentEvent(event,session));

    if(!tuiMode){
        console.error("session:",filePath);
        if(args.length===0){
            renderHistory(messages);
            if(checkpoint!==undefined) console.log("已恢复压缩后的模型上下文");
            if(session.sessionUsage.responses>0) renderSessionUsage(session);
        }
    }
    return session;
}

    async function resumeSession(lines:AsyncIterator<string>):Promise<boolean>{
        const filePath=await pickSession(sessionDirs,lines);
        if(filePath===undefined) return false;
        activateSession(filePath,await loadSessionLog(filePath,true));
        return true;
    }

    const initialOptions:LoopOptions={
        cwd,
        model:{providerId:"deepseek",modelId},
        thinkingJson:"{}",
        systemPrompt:buildSystemPrompt(cwd),
        maxOutputTokens,
        reserveTokens:compactAt===undefined?Math.max(16384,maxOutputTokens):model.contextWindow-compactAt,
        contextWindow:model.contextWindow,
        maxModelCalls,
        maxConcurrentTools,
        ToolExecutionMode:configuredToolMode,
    };
    const runtimeOptions=new RuntimeOptions(initialOptions,reasoningLevel,supportedReasoningLevels,model.maxTokens,compactAt);

    function formatRuntimeOptions():string{
        const current=runtimeOptions.get();
        return [
            `推理等级：${runtimeOptions.reasoningLevel}`,
            `单次输出上限：${current.maxOutputTokens.toLocaleString("en-US")} tokens`,
            `每次任务模型调用上限：${current.maxModelCalls}`,
            `工具执行：${current.ToolExecutionMode}`,
            `工具并发上限：${current.maxConcurrentTools}${current.ToolExecutionMode==="sequential"?"（顺序模式下不生效）":""}`,
            `上下文预留：${current.reserveTokens?.toLocaleString("en-US")} tokens`,
        ].join("\n");
    }

    function settingChoices(key:SettingKey):SelectItem[]{
        const current=runtimeOptions.get();
        let values:string[];
        let selected:string;
        switch(key){
            case "reasoning":
                values=[...runtimeOptions.supportedReasoningLevels];
                selected=runtimeOptions.reasoningLevel;
                break;
            case "max-output":{
                const limit=Math.min(runtimeOptions.maxOutputTokensLimit,
                    compactAt===undefined?runtimeOptions.maxOutputTokensLimit:current.contextWindow-compactAt);
                values=[8192,16384,32768,65536,131072,limit,current.maxOutputTokens]
                    .filter(value=>value<=limit).sort((a,b)=>a-b).map(String);
                selected=String(current.maxOutputTokens);
                break;
            }
            case "max-calls":
                values=[25,50,100,200,500,current.maxModelCalls].sort((a,b)=>a-b).map(String);
                selected=String(current.maxModelCalls);
                break;
            case "concurrency":
                values=[1,2,5,10,20,current.maxConcurrentTools].sort((a,b)=>a-b).map(String);
                selected=String(current.maxConcurrentTools);
                break;
            case "tool-mode":
                values=["sequential","parallel"];
                selected=current.ToolExecutionMode;
                break;
        }
        return [...new Set(values)].map(value=>({
            value,label:value,description:value===selected?"当前":"",
        }));
    }

    function applyRuntimeSetting(key:SettingKey,value:string):string{
        let update:RuntimeOptionsUpdate;
        switch(key){
            case "reasoning": update={reasoningLevel:value as ModelThinkingLevel}; break;
            case "max-output": update={maxOutputTokens:positiveInteger(value,0,"输出上限")}; break;
            case "max-calls": update={maxModelCalls:positiveInteger(value,0,"模型调用上限")}; break;
            case "concurrency": update={maxConcurrentTools:positiveInteger(value,0,"工具并发上限")}; break;
            case "tool-mode":
                if(value!=="parallel"&&value!=="sequential") throw new Error("执行模式必须为 parallel 或 sequential");
                update={toolExecutionMode:value};
                break;
        }
        const previousReasoning=runtimeOptions.reasoningLevel;
        runtimeOptions.set(update);
        if(previousReasoning!==runtimeOptions.reasoningLevel){
            activeSession?.invalidateContextUsage();
        }
        const detail=key==="tool-mode"&&value==="parallel"
            ?"；可并行的 Bash 调用也会并发执行"
            :"";
        return `运行设置已更新：${key} = ${value}${detail}（下次任务生效）`;
    }

    async function chooseRuntimeSetting(ui:OwlTui,key:SettingKey,value?:string):Promise<void>{
        const picked=value??(await ui.select("选择运行设置",settingChoices(key)))?.value;
        if(picked===undefined) return;
        const message=applyRuntimeSetting(key,picked);
        const context=activeSession?.state.messages.length
            ?activeSession.estimateContext(runtimeOptions.get()).estimatedInputTokens
            :null;
        ui.updateContext(context);
        ui.note(message,"success");
    }

    function handleTextSetting(text:string):boolean{
        const [command,...args]=text.split(/\s+/);
        if(command==="/settings"){
            if(args.length) throw new Error("/settings 不接受参数");
            console.log(formatRuntimeOptions());
            return true;
        }
        if(command==="/parallel"||command==="/sequential"){
            if(args.length) throw new Error(`${command} 不接受参数`);
            console.log(applyRuntimeSetting("tool-mode",command.slice(1)));
            return true;
        }
        if(!VALUE_COMMANDS.has(command)) return false;
        if(args.length>1) throw new Error(`${command} 最多接受一个参数`);
        const key=command.slice(1) as SettingKey;
        if(args.length===0){
            const suffix=key==="reasoning"?"":"；也可提供有效的自定义数值";
            console.log(`${command} 可选：${settingChoices(key).map(item=>item.value).join(", ")}${suffix}。`);
        }else{
            console.log(applyRuntimeSetting(key,args[0]));
        }
        return true;
    }

    function onAgentEvent(event:AgentEvent,session:AgentSession):void{
        if(tui!==undefined){
            tui.handleAgentEvent(event);
            return;
        }
        if(event.type==="turn_start"){
            const {estimatedInputTokens}=event.contextBudget;
            const {contextWindow}=runtimeOptions.get();
            const percent=100*estimatedInputTokens/contextWindow;
            console.log(
                `本次请求预计输入 ${formatTokens(estimatedInputTokens)} / ${formatTokens(contextWindow)} tokens（占窗口 ${percent.toFixed(1)}%）`,
            );
        }else if(event.type==="model_event"){
            const modelEvent=event.event;

            if(modelEvent.type==="done"){
                process.stdout.write("\n");
                renderSessionUsage(session);
            }else{
                process.stdout.write(modelEvent.delta);
            }
        }else if(event.type==="context_compaction_start"){
            console.log(event.reason==="overflow"?"模型报告上下文溢出，正在压缩…":"正在压缩上下文…");
        }else if(event.type==="context_compaction"){
            console.log(
                `上下文已压缩 · 预计输入 ${formatTokens(event.estimatedTokensBefore)} → ${formatTokens(event.contextBudget.estimatedInputTokens)} tokens`,
            );
        }else if(event.type==="compaction_usage"){
            renderSessionUsage(session);
        }else if(event.type==="tool_start"){
            console.log("\n工具调用：",event.call.name,event.call.argumentsJson);
        }else if(event.type==="tool_end"){
            console.dir(event.result,{depth:null});
        }
    }
    function renderSessionUsage(session:AgentSession):void{
        const usage=session.sessionUsage;
        const missing=usage.missingTotals>0
            ?`（${usage.missingTotals} 次未报告总量）`
            :"";
        console.log(`会话累计用量 ${formatTokens(usage.reportedTokens)} tokens${missing}`);
    }

    const runPrompt=async(text:string)=>{
        const session=activeSession??activateSession(
        join(sessionDirs.current,`${randomUUID()}.jsonl`),
        );
        const result=await session.prompt(text,runtimeOptions.get());
        // 取消收尾也可能写入工具回执，写入失败时应退出 CLI。
        if(persistenceError!==undefined){
            throw persistenceError;
        }

        if(!tuiMode){
            console.log("run:",{
                stopReason:result.stopReason,
                modelCalls:result.modelCalls,
            });

            if(result.errMessage!==undefined){
                console.error(result.errMessage);
            }
        }
        return result;
    };

    async function runCompact(customInstructions?:string):Promise<void>{
        if(activeSession===undefined) throw new Error("当前没有会话可压缩");
        await activeSession.compact(runtimeOptions.get(),customInstructions);
        if(persistenceError!==undefined) throw persistenceError;
    }

    function sessionLabelOf(filePath:string|undefined):string{
        if(filePath===undefined) return "新会话";
        const name=filePath.split(/[\\/]/).pop()??filePath;
        return name.replace(/\.jsonl$/,"").slice(0,8);
    }

    async function pickSessionInTui(ui:OwlTui):Promise<boolean>{
        const [current,legacyProject,legacyFlat]=await Promise.all([
            listSessions(sessionDirs.current),
            listSessions(sessionDirs.legacyProject),
            listSessions(sessionDirs.legacyRoot),
        ]);
        const rows=[...current,...legacyProject]
            .sort((a,b)=>b.mtimeMs-a.mtimeMs)
            .concat(legacyFlat);
        if(rows.length===0){
            ui.note("当前工作目录还没有已保存的会话。","dim");
            return false;
        }
        const items:SelectItem[]=rows.map(session=>({
            value:session.path,
            label:session.id,
            description:new Date(session.mtimeMs).toLocaleString(),
        }));
        const picked=await ui.select("恢复会话",items);
        if(picked===undefined) return false;

        const loaded=await loadSessionLog(picked.value,true);
        activateSession(picked.value,loaded);
        ui.reset(
            sessionLabelOf(picked.value),loaded.messages,loaded.checkpoint!==undefined,
            loaded.messages.length ? activeSession?.estimateContext(runtimeOptions.get()).estimatedInputTokens ?? null : null,
        );
        ui.note("已切换会话","success");
        return true;
    }

    async function runTuiFlow(openPicker:boolean):Promise<void>{
        let resolveDone:()=>void=()=>{};
        const done=new Promise<void>(resolve=>{
            resolveDone=resolve;
        });

        const ui=new OwlTui({
            cwd,
            modelId,
            contextWindow:runtimeOptions.get().contextWindow,
            runtimeSettings:()=>({
                reasoningLevel:runtimeOptions.reasoningLevel,
                toolMode:runtimeOptions.get().ToolExecutionMode,
            }),
            runUsage:()=>activeSession?.runUsage??createUsageTotals(),
            sessionUsage:()=>activeSession?.sessionUsage??createUsageTotals(),
            onSubmit:async text=>{
                const [token]=text.split(/\s+/,1);
                const command=token==="/quit"?"/exit":token;

                if(command!=="/compact"&&!VALUE_COMMANDS.has(command)&&Object.hasOwn(LOCAL_COMMANDS,command)&&text!==token){
                    ui.note(`${token} 不接受参数。`,"warning");
                    return;
                }
                if(command==="/exit"){
                    finish();
                    return;
                }
                if(command==="/help"){
                    ui.note(commandsText(),"dim");
                    return;
                }
                if(command==="/usage"){
                    ui.note(formatSessionUsage(
                        activeSession?.sessionUsage??createUsageTotals(),activeSession?.signal!==undefined,
                    ),"info");
                    return;
                }
                if(command==="/settings"){
                    const current=runtimeOptions.get();
                    const item=await ui.select("运行设置",[
                        {value:"reasoning",label:`推理等级：${runtimeOptions.reasoningLevel}`},
                        {value:"max-output",label:`单次输出上限：${current.maxOutputTokens} tokens`},
                        {value:"max-calls",label:`每次任务模型调用上限：${current.maxModelCalls}`},
                        {value:"tool-mode",label:`工具执行：${current.ToolExecutionMode}`},
                        {value:"concurrency",label:`工具并发上限：${current.maxConcurrentTools}`},
                    ]);
                    if(item!==undefined) await chooseRuntimeSetting(ui,item.value as SettingKey);
                    return;
                }
                if(command==="/parallel"||command==="/sequential"){
                    await chooseRuntimeSetting(ui,"tool-mode",command.slice(1));
                    return;
                }
                if(VALUE_COMMANDS.has(command)){
                    const args=text.split(/\s+/).slice(1);
                    if(args.length>1){
                        ui.note(`${command} 最多接受一个参数。`,"warning");
                        return;
                    }
                    await chooseRuntimeSetting(ui,command.slice(1) as SettingKey,args[0]);
                    return;
                }
                if(command==="/resume"){
                    await pickSessionInTui(ui);
                    return;
                }
                if(command==="/compact"){
                    try{
                        await runCompact(text.slice(token.length).trim()||undefined);
                    }catch(error:unknown){
                        if(persistenceError!==undefined){ finish(); return; }
                        if(error instanceof Error&&error.name==="AbortError") ui.note("已取消压缩","warning");
                        else ui.note(`压缩失败：${error instanceof Error?error.message:String(error)}`,"warning");
                    }
                    return;
                }
                if(/^\/[a-z][a-z0-9-]*$/i.test(token)){
                    ui.note(`未知命令 ${token}。输入 /help 查看命令。`,"warning");
                    return;
                }
                try{
                    await runPrompt(text);
                }catch(error){
                    if(persistenceError===undefined) throw error;
                    finish();
                }
            },
            onInterrupt:()=>{
                if(activeSession?.signal===undefined) return false;
                activeSession.abort();
                return true;
            },
            onExit:finish,
        });

        function finish():void{
            ui.stop();
            resolveDone();
        }

        tui=ui;
        try{
            if(activeSession!==undefined){
                ui.reset(
                    sessionLabelOf(activeSessionPath),activeSession.state.messages,
                    activeSession.compactionCheckpoint!==undefined,
                    activeSession.state.messages.length ? activeSession.estimateContext(runtimeOptions.get()).estimatedInputTokens : null,
                );
            }
            await ui.start(openPicker?"/resume":undefined);
            await done;
            if(persistenceError!==undefined) throw persistenceError;
        }finally{
            ui.stop();
            tui=undefined;
        }
    }

    const terminal=process.stdin.isTTY===true&&process.stdout.isTTY===true;
    if(values.tui&&values["no-tui"]){
        throw new Error("Choose either --tui or --no-tui");
    }
    const useTui=args.length===0&&terminal&&(values.tui||!values["no-tui"]);
    tuiMode=useTui;

    const input=(!useTui&&(args.length===0||values.resume))?createInterface({
        input:process.stdin,
        output:process.stdout,
        terminal,
        prompt:"owl> ",
    }):undefined;
    const lines=input?.[Symbol.asyncIterator]();
    let inputClosed=false;
    input?.once("close",()=>{
        inputClosed=true;
    });

    const onInterrupt=()=>{
        if(activeSession?.signal!==undefined){
            activeSession.abort();
        }else{
            process.exitCode=130;
            input?.close();
        }
    };
    process.on("SIGINT",onInterrupt);
    input?.on("SIGINT",onInterrupt);

    try{
        if(useTui){
            if(values.session!==undefined){
                const target=values.session;
                const isId=SESSION_ID_PATTERN.test(target);
                const filePath=isId?await findSessionById(target,sessionDirs):resolve(cwd,target);
                activateSession(filePath,await loadSessionLog(filePath,isId));
            }
            await runTuiFlow(values.resume);
            return;
        }

        if(values.resume&&lines!==undefined){
            if(!await resumeSession(lines)) return;
        }else if(values.session!==undefined){
            const target=values.session;
            const isId=SESSION_ID_PATTERN.test(target);
            const filePath=isId?await findSessionById(target,sessionDirs):resolve(cwd,target);
            activateSession(filePath,await loadSessionLog(filePath,isId));
        }

        if(args.length>0){
            input?.close();
            const text=args.join(" ").trim();
            try{
                if(handleTextSetting(text)) return;
            }catch(error:unknown){
                console.error(error instanceof Error?error.message:String(error));
                process.exitCode=1;
                return;
            }
            if(/^\/usage(?:\s|$)/.test(text)){
                if(text!=="/usage"){
                    console.error("/usage 不接受参数。");
                    process.exitCode=1;
                }else{
                    console.log(formatSessionUsage(activeSession?.sessionUsage??createUsageTotals()));
                }
                return;
            }
            if(/^\/compact(?:\s|$)/.test(text)){
                try{
                    await runCompact(text.slice("/compact".length).trim()||undefined);
                }catch(error:unknown){
                    if(persistenceError!==undefined) throw persistenceError;
                    if(error instanceof Error&&error.name==="AbortError"){
                        console.error("已取消压缩");
                        process.exitCode=130;
                    }else{
                        console.error(`压缩失败：${error instanceof Error?error.message:String(error)}`);
                        process.exitCode=1;
                    }
                }
                return;
            }
            const result=await runPrompt(text||"请只回答：通信成功");
            if(result.stopReason==="cancelled"){
                process.exitCode=130;
            }else if(result.stopReason!=="stop"){
                process.exitCode=1;
            }
            return;
        }

        if(terminal&&activeSession===undefined) showHome(cwd);
        while(lines!==undefined){
            if(terminal&&!inputClosed) input?.prompt();

            const line=await lines.next();
            if(line.done) break;
            const text=line.value.trim();
            if(text.length===0) continue;

            const [token]=text.split(/\s+/,1);
            const command=token==="/quit"?"/exit":token;
            if(command!=="/compact"&&!VALUE_COMMANDS.has(command)&&Object.hasOwn(LOCAL_COMMANDS,command)&&text!==token){
                console.error(`${token} 不接受参数。`);
                continue;
            }
            try{
                if(handleTextSetting(text)) continue;
            }catch(error:unknown){
                console.error(error instanceof Error?error.message:String(error));
                continue;
            }
            if(command==="/exit"){
                break;
            }
            if(command==="/help"){
                showCommands();
                continue;
            }
            if(command==="/usage"){
                console.log(formatSessionUsage(activeSession?.sessionUsage??createUsageTotals()));
                continue;
            }
            if(command==="/resume"){
                try{
                    await resumeSession(lines);
                }catch(error:unknown){
                    console.error(error instanceof Error?error.message:String(error));
                }
                continue;
            }
            if(command==="/compact"){
                try{
                    await runCompact(text.slice(token.length).trim()||undefined);
                }catch(error:unknown){
                    if(persistenceError!==undefined) throw persistenceError;
                    if(error instanceof Error&&error.name==="AbortError") console.log("已取消压缩");
                    else console.error(`压缩失败：${error instanceof Error?error.message:String(error)}`);
                }
                continue;
            }
            if(/^\/[a-z][a-z0-9-]*$/i.test(token)){
                console.error(`未知命令 ${token}。输入 /help 查看命令。`);
                continue;
            }
            await runPrompt(text);
        }
    }finally{
        input?.close();
        process.removeListener("SIGINT",onInterrupt);
        unsubscribe?.();
    }
}

main().catch((error:unknown)=>{
    if(error instanceof Error&&error.name==="AbortError"){
        console.error("\n已取消");
        process.exitCode=130;
        return;
    }

    console.error(error instanceof Error?error.message:String(error));
    process.exitCode=1;
});
