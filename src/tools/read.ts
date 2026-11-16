import {readFile} from "node:fs/promises";
import type{ImageBlock,JsonValue,TextBlock} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {detectSupportedImageMimeType} from "./mime.js";
import {resolveReadPathAsync} from "./path-utils.js";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    truncateHead,
    type TruncatedResult,
} from "./truncate.js";

const INLINE_IMAGE_MIME_TYPES=new Set(["image/png","image/jpeg","image/gif","image/webp"]);
const MAX_INLINE_IMAGE_BASE64_BYTES=4.5*1024*1024;
const MAX_READ_LIMIT=10000;

interface ReadInput{
    readonly path:string;
    readonly offset?:number;
    readonly limit?:number;
}

function readInteger(
    value:number|undefined,
    minimum:number,
    maximum:number,
    name:string,
):number|undefined{
    if(value===undefined){
        return undefined;
    }
    if(!Number.isInteger(value)||value<minimum||value>maximum){
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

export const ReadTool:AgentTool={
    definition:{
        name:"read",
        description:`Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES/1024}KB (whichever is hit first). An explicit limit is honored up to ${MAX_READ_LIMIT} lines; the byte limit still applies. Use offset/limit for large files.`,
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                path:{
                    type:"string",
                    description:"Path to the file to read (relative or absolute)",
                },
                offset:{
                    type:"integer",
                    minimum:1,
                    description:"Line number to start reading from (1-indexed)",
                },
                limit:{
                    type:"integer",
                    minimum:1,
                    maximum:MAX_READ_LIMIT,
                    description:`Maximum number of lines to read (max ${MAX_READ_LIMIT})`,
                },
            },
            required:["path"],
            additionalProperties:false,
        }),
    },
    mode:"parallel",

    async execute(args,context):Promise<ToolResult>{
        const input=args as ReadInput;
        context.signal.throwIfAborted();
        const offset=readInteger(input.offset,1,Number.MAX_SAFE_INTEGER,"offset");
        const limit=readInteger(input.limit,1,MAX_READ_LIMIT,"limit");
        const absolutePath=await resolveReadPathAsync(input.path,context.cwd);
        context.signal.throwIfAborted();
        const buffer=await readFile(absolutePath);
        context.signal.throwIfAborted();

        const mimeType=detectSupportedImageMimeType(buffer);
        if(mimeType!==null){
            return {content:toImageContent(buffer,mimeType)};
        }

        const textContent=buffer.toString("utf-8");
        const allLines=textContent.split("\n");
        const totalFileLines=allLines.length;
        const startLine=offset!==undefined?offset-1:0;
        const startLineDisplay=startLine+1;
        if(startLine>=allLines.length){
            throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
        }

        let selectedContent:string;
        let userLimitedLines:number|undefined;
        if(limit!==undefined){
            const endLine=Math.min(startLine+limit,allLines.length);
            selectedContent=allLines.slice(startLine,endLine).join("\n");
            userLimitedLines=endLine-startLine;
        }else{
            selectedContent=allLines.slice(startLine).join("\n");
        }

        const truncation=truncateHead(selectedContent,{maxLines:limit??DEFAULT_MAX_LINES});
        let outputText:string;
        let details:JsonValue|undefined;
        if(truncation.firstLineExceedsLimit){
            const firstLineSize=formatSize(Buffer.byteLength(allLines[startLine],"utf-8"));
            outputText=`[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
            details=truncationDetails(truncation);
        }else if(truncation.truncated){
            const endLineDisplay=startLineDisplay+truncation.outputLines-1;
            const nextOffset=endLineDisplay+1;
            outputText=truncation.content;
            if(truncation.truncatedBy==="lines"){
                outputText+=`\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
            }else{
                outputText+=`\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
            }
            details=truncationDetails(truncation);
        }else if(userLimitedLines!==undefined&&startLine+userLimitedLines<allLines.length){
            const remaining=allLines.length-(startLine+userLimitedLines);
            const nextOffset=startLine+userLimitedLines+1;
            outputText=`${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
        }else{
            outputText=truncation.content;
        }

        context.signal.throwIfAborted();
        return {
            content:[{type:"text",text:outputText}],
            details:details,
        };
    },
};

function toImageContent(buffer:Buffer,mimeType:string):(TextBlock|ImageBlock)[]{
    const text=`Read image file [${mimeType}]`;
    if(!INLINE_IMAGE_MIME_TYPES.has(mimeType)){
        return [{
            type:"text",
            text:`${text}\n[Image omitted: could not be converted to a supported inline image format.]`,
        }];
    }
    const data=buffer.toString("base64");
    if(Buffer.byteLength(data,"utf-8")>=MAX_INLINE_IMAGE_BASE64_BYTES){
        return [{
            type:"text",
            text:`${text}\n[Image omitted: could not be resized below the inline image size limit.]`,
        }];
    }
    return [{type:"text",text:text},{type:"image",data:data,mimeType:mimeType}];
}

function truncationDetails(truncation:TruncatedResult):JsonValue{
    return {
        truncation:{
            content:truncation.content,
            truncated:truncation.truncated,
            truncatedBy:truncation.truncatedBy,
            totalLines:truncation.totalLines,
            totalBytes:truncation.totalBytes,
            outputLines:truncation.outputLines,
            outputBytes:truncation.outputBytes,
            lastLinePartial:truncation.lastLinePartial,
            firstLineExceedsLimit:truncation.firstLineExceedsLimit,
            maxLines:truncation.maxLines,
            maxBytes:truncation.maxBytes,
        },
    };
}
