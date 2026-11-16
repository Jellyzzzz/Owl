import {isAbsolute,join} from "node:path";
import type{JsonValue} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {inspectSearchPath,matchesPathPattern,relativeSearchPath} from "./file-search.js";
import {resolveToCwd} from "./path-utils.js";
import {runRipgrep} from "./ripgrep.js";
import {
    DEFAULT_MAX_BYTES,
    formatSize,
    type TruncationResult,
} from "./truncate.js";

const DEFAULT_LIMIT=1000;
const MAX_LIMIT=10000;

interface FindInput{
    readonly pattern:string;
    readonly path?:string;
    readonly limit?:number;
}

export interface FindToolDetails{
    truncation?:TruncationResult;
    resultLimitReached?:number;
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

function pathFromChunk(searchPath:string,isDirectory:boolean,rawPath:string):string{
    if(isAbsolute(rawPath)){
        return rawPath;
    }
    if(isDirectory){
        return join(searchPath,rawPath);
    }
    return searchPath;
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

export const FindTool:AgentTool={
    definition:{
        name:"find",
        description:`Search for files by glob pattern. Returns matching file paths relative to the search directory. Uses ripgrep, so .gitignore and ignore files are respected (including outside Git repositories) and deleted index entries are not returned. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES/1024}KB (whichever is hit first).`,
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                pattern:{
                    type:"string",
                    minLength:1,
                    description:"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
                },
                path:{
                    type:"string",
                    description:"Directory to search in (default: current directory)",
                },
                limit:{
                    type:"integer",
                    minimum:1,
                    maximum:MAX_LIMIT,
                    description:`Maximum number of results (default: ${DEFAULT_LIMIT})`,
                },
            },
            required:["pattern"],
            additionalProperties:false,
        }),
    },
    mode:"parallel",

    async execute(args,context):Promise<ToolResult>{
        const input=args as FindInput;
        context.signal.throwIfAborted();
        if(typeof input.pattern!=="string"||input.pattern.length===0){
            throw new Error("pattern must be a non-empty string");
        }
        const limit=integerInRange(input.limit,DEFAULT_LIMIT,1,MAX_LIMIT,"limit");
        const searchPath=resolveToCwd(input.path??".",context.cwd);
        const {isDirectory}=await inspectSearchPath(searchPath);

        if(!isDirectory){
            const relativePath=relativeSearchPath(searchPath,searchPath,false);
            if(!matchesPathPattern(relativePath,input.pattern)){
                return {content:[{type:"text",text:"No files found matching pattern"}]};
            }
            return {content:[{type:"text",text:relativePath}]};
        }

        const matches:string[]=[];
        let outputBytes=0;
        let moreResults=false;
        let byteTruncated=false;
        let pending="";

        const onStdout=(chunk:string):boolean=>{
            pending+=chunk;
            let separator=pending.indexOf("\0");
            while(separator!==-1){
                const rawPath=pending.slice(0,separator);
                pending=pending.slice(separator+1);
                separator=pending.indexOf("\0");
                if(rawPath.length===0){
                    continue;
                }
                const filePath=pathFromChunk(searchPath,true,rawPath);
                const relativePath=relativeSearchPath(searchPath,filePath,true);
                if(!matchesPathPattern(relativePath,input.pattern)){
                    continue;
                }
                if(matches.length>=limit){
                    moreResults=true;
                    return false;
                }
                const lineBytes=Buffer.byteLength(relativePath,"utf-8")+(matches.length>0?1:0);
                if(outputBytes+lineBytes>DEFAULT_MAX_BYTES){
                    byteTruncated=true;
                    return false;
                }
                matches.push(relativePath);
                outputBytes+=lineBytes;
            }
            return true;
        };

        const result=await runRipgrep({
            args:[
                "--files",
                "--hidden",
                "--no-config",
                "--no-require-git",
                "--null",
                "--sort","path",
                "--",
                searchPath,
            ],
            cwd:context.cwd,
            signal:context.signal,
            onStdout:onStdout,
        });
        context.signal.throwIfAborted();

        const errors=errorCount(result.stderr);
        const incomplete=result.exitCode===2&&!result.stopped;
        if(result.exitCode===2&&!result.stopped&&matches.length===0){
            throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode}`}`);
        }
        if(result.exitCode!==0&&result.exitCode!==1&&result.exitCode!==2&&!result.stopped){
            throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode??"unknown"}`}`);
        }
        if(matches.length===0){
            if(incomplete){
                throw new Error(`ripgrep failed: ${result.stderr||`exit code ${result.exitCode}`}`);
            }
            if(byteTruncated){
                return {
                    content:[{type:"text",text:`[${formatSize(DEFAULT_MAX_BYTES)} limit reached before any results could be returned]`}],
                    details:{truncation:byteLimitTruncation(0,0)} as unknown as JsonValue,
                };
            }
            return {content:[{type:"text",text:"No files found matching pattern"}]};
        }

        const details:FindToolDetails={};
        const notices:string[]=[];
        if(moreResults){
            notices.push(`${limit} results limit reached. Use limit=${Math.min(limit*2,MAX_LIMIT)} for more, or refine pattern`);
            details.resultLimitReached=limit;
        }
        if(byteTruncated){
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation=byteLimitTruncation(matches.length,outputBytes);
        }
        if(incomplete){
            const detail=errors>0?`ripgrep reported ${errors} error(s)`:"ripgrep exited with code 2";
            notices.push(`Search incomplete: ${detail}; some files may have been skipped`);
            details.incomplete=true;
            details.errorCount=errors;
            details.skippedCount=errors;
        }
        let output=matches.join("\n");
        if(notices.length>0){
            output+=`\n\n[${notices.join(". ")}]`;
        }
        return {
            content:[{type:"text",text:output}],
            details:Object.keys(details).length>0?details as JsonValue:undefined,
        };
    },
};
