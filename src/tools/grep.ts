import {readFile,stat} from "node:fs/promises";
import type{JsonValue} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {listFiles,matchesPathPattern,relativeSearchPath} from "./file-search.js";
import {resolveToCwd} from "./path-utils.js";
import {
    DEFAULT_MAX_BYTES,
    GREP_MAX_LINE_LENGTH,
    formatSize,
    truncateHead,
    truncateLine,
    type TruncationResult,
} from "./truncate.js";

const DEFAULT_LIMIT=100;

interface GrepInput{
    readonly pattern:string;
    readonly path?:string;
    readonly glob?:string;
    readonly ignoreCase?:boolean;
    readonly literal?:boolean;
    readonly context?:number;
    readonly limit?:number;
}

interface GrepMatch{
    readonly filePath:string;
    readonly lineNumber:number;
    readonly lines:readonly string[];
}

export interface GrepToolDetails{
    truncation?:TruncationResult;
    matchLimitReached?:number;
    linesTruncated?:boolean;
}

function positiveLimit(value:number|undefined,fallback:number):number{
    const limit=value??fallback;
    return Number.isFinite(limit)?Math.max(1,Math.floor(limit)):fallback;
}
function contextSize(value:number|undefined):number{
    return typeof value==="number"&&Number.isFinite(value)&&value>0
        ?Math.floor(value)
        :0;
}
function escapeRegExp(text:string):string{
    return text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

export const GrepTool:AgentTool={
    definition:{
        name:"grep",
        description:`Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES/1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                pattern:{
                    type:"string",
                    description:"Search pattern (regex or literal string)",
                },
                path:{
                    type:"string",
                    description:"Directory or file to search (default: current directory)",
                },
                glob:{
                    type:"string",
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
                    type:"number",
                    description:"Number of lines to show before and after each match (default: 0)",
                },
                limit:{
                    type:"number",
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
        const searchPath=resolveToCwd(input.path??".",context.cwd);
        let isDirectory:boolean;
        try{
            isDirectory=(await stat(searchPath)).isDirectory();
        }catch{
            throw new Error(`Path not found: ${searchPath}`);
        }

        let matcher:RegExp;
        try{
            matcher=new RegExp(
                input.literal?escapeRegExp(input.pattern):input.pattern,
                input.ignoreCase?"i":"",
            );
        }catch(error:unknown){
            throw new Error(`Invalid regular expression: ${error instanceof Error?error.message:String(error)}`);
        }

        const contextLines=contextSize(input.context);
        const limit=positiveLimit(input.limit,DEFAULT_LIMIT);
        const files=await listFiles(searchPath,context.signal);
        const matches:GrepMatch[]=[];
        let matchLimitReached=false;

        for(const filePath of files){
            context.signal.throwIfAborted();
            const relativePath=relativeSearchPath(searchPath,filePath,isDirectory);
            if(input.glob!==undefined&&!matchesPathPattern(relativePath,input.glob)){
                continue;
            }
            let content:string;
            try{
                content=(await readFile(filePath)).toString("utf-8");
            }catch{
                continue;
            }
            if(content.includes("\0")){
                continue;
            }
            const lines=content.split(/\r\n|\r|\n/);
            for(let index=0;index<lines.length;index++){
                context.signal.throwIfAborted();
                if(!matcher.test(lines[index]??"")){
                    continue;
                }
                matches.push({
                    filePath:filePath,
                    lineNumber:index+1,
                    lines:lines,
                });
                if(matches.length>=limit){
                    matchLimitReached=true;
                    break;
                }
            }
            if(matchLimitReached){
                break;
            }
        }

        if(matches.length===0){
            return {content:[{type:"text",text:"No matches found"}]};
        }

        const outputLines:string[]=[];
        let linesTruncated=false;
        for(const match of matches){
            const relativePath=relativeSearchPath(searchPath,match.filePath,isDirectory);
            const start=contextLines>0?Math.max(1,match.lineNumber-contextLines):match.lineNumber;
            const end=contextLines>0?Math.min(match.lines.length,match.lineNumber+contextLines):match.lineNumber;
            for(let lineNumber=start;lineNumber<=end;lineNumber++){
                const rawLine=(match.lines[lineNumber-1]??"").replace(/\r/g,"");
                const truncated=truncateLine(rawLine);
                if(truncated.wasTruncated){
                    linesTruncated=true;
                }
                const isMatchLine=lineNumber===match.lineNumber;
                outputLines.push(
                    isMatchLine
                        ?`${relativePath}:${lineNumber}: ${truncated.text}`
                        :`${relativePath}-${lineNumber}- ${truncated.text}`,
                );
            }
        }

        const rawOutput=outputLines.join("\n");
        const truncation=truncateHead(rawOutput,{maxLines:Number.MAX_SAFE_INTEGER});
        let output=truncation.content;
        const details:GrepToolDetails={};
        const notices:string[]=[];
        if(matchLimitReached){
            notices.push(`${limit} matches limit reached. Use limit=${limit*2} for more, or refine pattern`);
            details.matchLimitReached=limit;
        }
        if(truncation.truncated){
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation=truncation;
        }
        if(linesTruncated){
            notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
            details.linesTruncated=true;
        }
        if(notices.length>0){
            output+=`\n\n[${notices.join(". ")}]`;
        }
        return {
            content:[{type:"text",text:output}],
            details:Object.keys(details).length>0?details as JsonValue:undefined,
        };
    },
};
