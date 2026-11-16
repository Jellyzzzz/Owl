import {isAbsolute,join} from "node:path";
import type{JsonValue} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {inspectSearchPath,relativeSearchPath} from "./file-search.js";
import {resolveToCwd} from "./path-utils.js";
import {runRipgrep} from "./ripgrep.js";
import {
    DEFAULT_MAX_BYTES,
    GREP_MAX_LINE_LENGTH,
    formatSize,
    truncateLine,
    type TruncationResult,
} from "./truncate.js";

const DEFAULT_LIMIT=100;
const MAX_LIMIT=1000;
const MAX_CONTEXT=20;

interface GrepInput{
    readonly pattern:string;
    readonly path?:string;
    readonly glob?:string;
    readonly ignoreCase?:boolean;
    readonly literal?:boolean;
    readonly context?:number;
    readonly limit?:number;
}

interface RipgrepText{
    readonly text?:string;
    readonly bytes?:string;
}

interface RipgrepJsonData{
    readonly path?:RipgrepText;
    readonly lines?:RipgrepText;
    readonly line_number?:number;
}

interface RipgrepJsonEvent{
    readonly type?:string;
    readonly data?:RipgrepJsonData;
}

interface FormattedEvent{
    readonly line:string;
    readonly wasTruncated:boolean;
}

export interface GrepToolDetails{
    truncation?:TruncationResult;
    matchLimitReached?:number;
    linesTruncated?:boolean;
    incomplete?:boolean;
    errorCount?:number;
    skippedCount?:number;
}

function integerInRange(
    value:number|undefined,
    fallback:number,
    minimum:number,
    maximum:number,
    name:string,
):number{
    if(value===undefined){
        return fallback;
    }
    if(!Number.isInteger(value)||value<minimum||value>maximum){
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

function decodeText(value:RipgrepText|undefined):string|undefined{
    if(value?.text!==undefined){
        return value.text;
    }
    if(value?.bytes!==undefined){
        return Buffer.from(value.bytes,"base64").toString("utf-8");
    }
    return undefined;
}

function stripLineEnding(text:string):string{
    return text.replace(/\r?\n$/,"").replace(/\r$/,"");
}

function absoluteEventPath(searchPath:string,isDirectory:boolean,rawPath:string):string{
    if(isAbsolute(rawPath)){
        return rawPath;
    }
    return isDirectory?join(searchPath,rawPath):searchPath;
}

function errorCount(stderr:string):number{
    return stderr.split("\n").filter(line=>line.trim().length>0).length;
}

function byteLimitTruncation(outputLines:number,outputBytes:number):TruncationResult{
    return {
        content:"",
        truncated:true,
        truncatedBy:"bytes",
        totalLines:outputLines+1,
        totalBytes:outputBytes+1,
        outputLines:outputLines,
        outputBytes:outputBytes,
        lastLinePartial:false,
        firstLineExceedsLimit:false,
        maxLines:Number.MAX_SAFE_INTEGER,
        maxBytes:DEFAULT_MAX_BYTES,
    };
}

export const GrepTool:AgentTool={
    definition:{
        name:"grep",
        description:`Search file contents for a pattern. Returns matching lines with file paths and line numbers. Uses ripgrep, so .gitignore and ignore files are respected (including outside Git repositories). Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES/1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                pattern:{
                    type:"string",
                    minLength:1,
                    description:"Search pattern (regex or literal string)",
                },
                path:{
                    type:"string",
                    description:"Directory or file to search (default: current directory)",
                },
                glob:{
                    type:"string",
                    minLength:1,
                    description:"Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
                },
                ignoreCase:{
                    type:"boolean",
                    description:"Case-insensitive search (default: false)",
                },
                literal:{
                    type:"boolean",
                    description:"Treat pattern as literal string instead of regex (default: false)",
                },
                context:{
                    type:"integer",
                    minimum:0,
                    maximum:MAX_CONTEXT,
                    description:`Number of lines to show before and after each match (default: 0)`,
                },
                limit:{
                    type:"integer",
                    minimum:1,
                    maximum:MAX_LIMIT,
                    description:`Maximum number of matches to return (default: ${DEFAULT_LIMIT})`,
                },
            },
            required:["pattern"],
            additionalProperties:false,
        }),
    },
    mode:"parallel",

    async execute(args,context):Promise<ToolResult>{
        const input=args as GrepInput;
        context.signal.throwIfAborted();
        if(typeof input.pattern!=="string"||input.pattern.length===0){
            throw new Error("pattern must be a non-empty string");
        }
        if(input.glob!==undefined&&(typeof input.glob!=="string"||input.glob.length===0)){
            throw new Error("glob must be a non-empty string");
        }
        const contextLines=integerInRange(input.context,0,0,MAX_CONTEXT,"context");
        const limit=integerInRange(input.limit,DEFAULT_LIMIT,1,MAX_LIMIT,"limit");
        const searchPath=resolveToCwd(input.path??".",context.cwd);
        const {isDirectory}=await inspectSearchPath(searchPath);

        const outputLines:string[]=[];
        let outputBytes=0;
        let outputTruncated=false;
        let linesTruncated=false;
        let matchCount=0;
        let moreMatches=false;
        let atLimit=false;
        let afterContext=0;
        let pendingContext:FormattedEvent[]=[];
        let stdoutBuffer="";

        const appendLine=(line:string):boolean=>{
            const lineBytes=Buffer.byteLength(line,"utf-8")+(outputLines.length>0?1:0);
            if(outputBytes+lineBytes>DEFAULT_MAX_BYTES){
                outputTruncated=true;
                return false;
            }
            outputLines.push(line);
            outputBytes+=lineBytes;
            return true;
        };

        const emit=(event:FormattedEvent):boolean=>{
            if(event.wasTruncated){
                linesTruncated=true;
            }
            return appendLine(event.line);
        };

        const formatEvent=(event:RipgrepJsonEvent,marker:":"|"-"):FormattedEvent|undefined=>{
            const rawPath=decodeText(event.data?.path);
            const rawLine=decodeText(event.data?.lines);
            const lineNumber=event.data?.line_number;
            if(rawPath===undefined||rawLine===undefined||!Number.isInteger(lineNumber)||(lineNumber??0)<1){
                return undefined;
            }
            const filePath=absoluteEventPath(searchPath,isDirectory,rawPath);
            const relativePath=relativeSearchPath(searchPath,filePath,isDirectory);
            const truncated=truncateLine(stripLineEnding(rawLine));
            return {
                line:marker===":"
                    ?`${relativePath}:${lineNumber}: ${truncated.text}`
                    :`${relativePath}-${lineNumber}- ${truncated.text}`,
                wasTruncated:truncated.wasTruncated,
            };
        };

        const handleEvent=(event:RipgrepJsonEvent):boolean=>{
            if(event.type==="context"){
                const formatted=formatEvent(event,"-");
                if(formatted===undefined){
                    return true;
                }
                if(afterContext>0){
                    afterContext--;
                    return emit(formatted);
                }
                if(atLimit){
                    moreMatches=true;
                    return false;
                }
                pendingContext.push(formatted);
                if(pendingContext.length>contextLines){
                    pendingContext.shift();
                }
                return true;
            }
            if(event.type!=="match"){
                return true;
            }

            const formatted=formatEvent(event,":");
            if(formatted===undefined){
                return true;
            }
            if(matchCount>=limit){
                moreMatches=true;
                return false;
            }
            matchCount++;
            for(const pending of pendingContext){
                if(!emit(pending)){
                    return false;
                }
            }
            pendingContext=[];
            if(!emit(formatted)){
                return false;
            }
            atLimit=matchCount>=limit;
            afterContext=contextLines;
            return true;
        };

        const onStdout=(chunk:string):boolean=>{
            stdoutBuffer+=chunk;
            let newline=stdoutBuffer.indexOf("\n");
            while(newline!==-1){
                const line=stdoutBuffer.slice(0,newline);
                stdoutBuffer=stdoutBuffer.slice(newline+1);
                newline=stdoutBuffer.indexOf("\n");
                if(line.trim().length===0){
                    continue;
                }
                let event:RipgrepJsonEvent;
                try{
                    event=JSON.parse(line) as RipgrepJsonEvent;
                }catch(error:unknown){
                    throw new Error(`Invalid ripgrep JSON output: ${error instanceof Error?error.message:String(error)}`);
                }
                if(handleEvent(event)===false){
                    return false;
                }
            }
            return true;
        };

        const result=await runRipgrep({
            args:[
                "--json",
                "--line-number",
                "--color=never",
                "--no-config",
                "--no-require-git",
                "--hidden",
                ...(input.ignoreCase?["--ignore-case"]:[]),
                ...(input.literal?["--fixed-strings"]:[]),
                ...(contextLines>0?["--context",String(contextLines)]:[]),
                ...(input.glob!==undefined?["--glob",input.glob]:[]),
                "-e",input.pattern,
                "--",
                searchPath,
            ],
            cwd:context.cwd,
            signal:context.signal,
            onStdout:onStdout,
        });
        context.signal.throwIfAborted();

        if(stdoutBuffer.trim().length>0&&!result.stopped){
            let event:RipgrepJsonEvent;
            try{
                event=JSON.parse(stdoutBuffer) as RipgrepJsonEvent;
            }catch(error:unknown){
                throw new Error(`Invalid ripgrep JSON output: ${error instanceof Error?error.message:String(error)}`);
            }
            handleEvent(event);
        }

        const errors=errorCount(result.stderr);
        const incomplete=result.exitCode===2&&!result.stopped;
        if(result.exitCode===2&&!result.stopped&&outputLines.length===0){
            throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode}`}`);
        }
        if(result.exitCode!==0&&result.exitCode!==1&&result.exitCode!==2&&!result.stopped){
            throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode??"unknown"}`}`);
        }
        if(outputLines.length===0){
            if(incomplete){
                throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode}`}`);
            }
            if(outputTruncated){
                return {
                    content:[{type:"text",text:`[${formatSize(DEFAULT_MAX_BYTES)} limit reached before any matches could be returned]`}],
                    details:{truncation:byteLimitTruncation(0,0)} as unknown as JsonValue,
                };
            }
            return {content:[{type:"text",text:"No matches found"}]};
        }

        const details:GrepToolDetails={};
        const notices:string[]=[];
        if(moreMatches){
            notices.push(`${limit} matches limit reached. Use limit=${Math.min(limit*2,MAX_LIMIT)} for more, or refine pattern`);
            details.matchLimitReached=limit;
        }
        if(outputTruncated){
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation=byteLimitTruncation(outputLines.length,outputBytes);
        }
        if(linesTruncated){
            notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
            details.linesTruncated=true;
        }
        if(incomplete){
            const detail=errors>0?`ripgrep reported ${errors} error(s)`:"ripgrep exited with code 2";
            notices.push(`Search incomplete: ${detail}; some files may have been skipped`);
            details.incomplete=true;
            details.errorCount=errors;
            details.skippedCount=errors;
        }
        let output=outputLines.join("\n");
        if(notices.length>0){
            output+=`\n\n[${notices.join(". ")}]`;
        }
        return {
            content:[{type:"text",text:output}],
            details:Object.keys(details).length>0?details as JsonValue:undefined,
        };
    },
};
