import {stat} from "node:fs/promises";
import type{JsonValue} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {listFiles,matchesPathPattern,relativeSearchPath} from "./file-search.js";
import {resolveToCwd} from "./path-utils.js";
import {
    DEFAULT_MAX_BYTES,
    formatSize,
    truncateHead,
    type TruncationResult,
} from "./truncate.js";

const DEFAULT_LIMIT=1000;

interface FindInput{
    readonly pattern:string;
    readonly path?:string;
    readonly limit?:number;
}

export interface FindToolDetails{
    truncation?:TruncationResult;
    resultLimitReached?:number;
}

function positiveLimit(value:number|undefined,fallback:number):number{
    const limit=value??fallback;
    return Number.isFinite(limit)?Math.max(1,Math.floor(limit)):fallback;
}

export const FindTool:AgentTool={
    definition:{
        name:"find",
        description:`Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES/1024}KB (whichever is hit first).`,
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                pattern:{
                    type:"string",
                    description:"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
                },
                path:{
                    type:"string",
                    description:"Directory to search in (default: current directory)",
                },
                limit:{
                    type:"number",
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
        const searchPath=resolveToCwd(input.path??".",context.cwd);
        let isDirectory:boolean;
        try{
            isDirectory=(await stat(searchPath)).isDirectory();
        }catch{
            throw new Error(`Path not found: ${searchPath}`);
        }

        const files=await listFiles(searchPath,context.signal);
        const limit=positiveLimit(input.limit,DEFAULT_LIMIT);
        const matches:string[]=[];
        for(const filePath of files){
            context.signal.throwIfAborted();
            const relativePath=relativeSearchPath(searchPath,filePath,isDirectory);
            if(matchesPathPattern(relativePath,input.pattern)){
                matches.push(relativePath);
            }
        }
        matches.sort((left,right)=>left.localeCompare(right));
        if(matches.length===0){
            return {content:[{type:"text",text:"No files found matching pattern"}]};
        }

        const resultLimitReached=matches.length>=limit;
        const rawOutput=matches.slice(0,limit).join("\n");
        const truncation=truncateHead(rawOutput,{maxLines:Number.MAX_SAFE_INTEGER});
        let output=truncation.content;
        const details:FindToolDetails={};
        const notices:string[]=[];
        if(resultLimitReached){
            notices.push(`${limit} results limit reached. Use limit=${limit*2} for more, or refine pattern`);
            details.resultLimitReached=limit;
        }
        if(truncation.truncated){
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation=truncation;
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
