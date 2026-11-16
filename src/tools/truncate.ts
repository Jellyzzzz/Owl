export const DEFAULT_MAX_LINES=1200;
export const DEFAULT_MAX_BYTES=12*1024;
export const GREP_MAX_LINE_LENGTH=500;

export interface TruncatedResult{
    content:string;
    truncated:boolean;
    truncatedBy:"lines"|"bytes"|null;
    totalLines:number;
    totalBytes:number;
    outputLines:number;
    outputBytes:number;
    lastLinePartial:boolean;
    firstLineExceedsLimit:boolean;
    maxLines:number;
    maxBytes:number;
}
export type TruncationResult=TruncatedResult;
export interface TruncatedOptions{
    maxLines?:number;
    maxBytes?:number;
}
function splitLinesForCounting(content:string):string[]{
    if(content.length===0){
        return [];
    }
    const lines=content.split("\n");
    if(content.endsWith("\n")){
        lines.pop();
    }
    return lines;
}
export function formatSize(bytes:number):string{
    if(bytes<1024){
        return `${bytes}B`;
    }
    if(bytes<1024*1024){
        return `${(bytes/1024).toFixed(1)}KB`;
    }
    return `${(bytes/(1024*1024)).toFixed(1)}MB`;
}
export function truncateLine(line:string,maxChars=GREP_MAX_LINE_LENGTH):{text:string;wasTruncated:boolean}{
    if(line.length<=maxChars){
        return {text:line,wasTruncated:false};
    }
    return {text:`${line.slice(0,maxChars)}... [truncated]`,wasTruncated:true};
}
export function truncateHead(content:string,options:TruncatedOptions={}):TruncatedResult{
    const maxLines=options.maxLines??DEFAULT_MAX_LINES;
    const maxBytes=options.maxBytes??DEFAULT_MAX_BYTES;

    const totalBytes=Buffer.byteLength(content,"utf-8");
    const lines=splitLinesForCounting(content);
    const totalLines=lines.length;

    if(totalLines<=maxLines&&totalBytes<=maxBytes){
        return {
            content:content,
            truncated:false,
            truncatedBy:null,
            totalLines:totalLines,
            totalBytes:totalBytes,
            outputLines:totalLines,
            outputBytes:totalBytes,
            lastLinePartial:false,
            firstLineExceedsLimit:false,
            maxLines:maxLines,
            maxBytes:maxBytes,
        };
    }

    const firstLineBytes=Buffer.byteLength(lines[0]??"","utf-8");
    if(firstLineBytes>maxBytes){
        return {
            content:"",
            truncated:true,
            truncatedBy:"bytes",
            totalLines:totalLines,
            totalBytes:totalBytes,
            outputLines:0,
            outputBytes:0,
            lastLinePartial:false,
            firstLineExceedsLimit:true,
            maxLines:maxLines,
            maxBytes:maxBytes,
        };
    }

    const outputLinesArr:string[]=[];
    let outputBytesCount=0;
    let truncatedBy:"lines"|"bytes"="lines";
    for(let i=0;i<lines.length&&i<maxLines;i++){
        const line=lines[i];
        const lineBytes=Buffer.byteLength(line,"utf-8")+(i>0?1:0);
        if(outputBytesCount+lineBytes>maxBytes){
            truncatedBy="bytes";
            break;
        }
        outputLinesArr.push(line);
        outputBytesCount+=lineBytes;
    }
    if(outputLinesArr.length>=maxLines&&outputBytesCount<=maxBytes){
        truncatedBy="lines";
    }
    const outputContent=outputLinesArr.join("\n");
    return {
        content:outputContent,
        truncated:true,
        truncatedBy:truncatedBy,
        totalLines:totalLines,
        totalBytes:totalBytes,
        outputLines:outputLinesArr.length,
        outputBytes:Buffer.byteLength(outputContent,"utf-8"),
        lastLinePartial:false,
        firstLineExceedsLimit:false,
        maxLines:maxLines,
        maxBytes:maxBytes,
    };
}
function truncateStringToBytesFromEnd(totalText:string,maxBytes:number):string{
    const buffer=Buffer.from(totalText,"utf-8");
    if(buffer.length<maxBytes){
        return totalText;
    }
    let start=Math.max(0,buffer.length-maxBytes);
    while(start<buffer.length&&(buffer[start]&0xc0)===0x80){
        start++;
    }
    return buffer.subarray(start).toString("utf-8");
}
export function truncateTail(content:string,options:TruncatedOptions={}):TruncatedResult{
    const maxLines=options.maxLines??DEFAULT_MAX_LINES;
    const maxBytes=options.maxBytes??DEFAULT_MAX_BYTES;

    const totalBytes=Buffer.byteLength(content,"utf-8");
    const lines=splitLinesForCounting(content);
    const totalLines=lines.length;
    let lastLinePartial=false;

    if(totalLines<=maxLines&&totalBytes<=maxBytes){
        return {
            content:content,
            truncated:false,
            truncatedBy:null,
            totalLines:totalLines,
            totalBytes:totalBytes,
            outputLines:totalLines,
            outputBytes:totalBytes,
            lastLinePartial:false,
            firstLineExceedsLimit:false,
            maxLines:maxLines,
            maxBytes:maxBytes,
        };
    }
    const outputLinesArr:string[]=[];
    let outputBytesCount=0;
    let truncatedBy:"lines"|"bytes"="lines";

    for(let i=lines.length-1;i>=0&&outputLinesArr.length<maxLines;i--){
        const line=lines[i];
        const lineBytes=Buffer.byteLength(line,"utf-8")+(outputLinesArr.length===0?0:1);
        if(outputBytesCount+lineBytes>maxBytes){
            truncatedBy="bytes";
            if(outputLinesArr.length===0){
                const truncatedLine=truncateStringToBytesFromEnd(line,maxBytes);
                outputLinesArr.unshift(truncatedLine);
                outputBytesCount=Buffer.byteLength(truncatedLine,"utf-8");
                lastLinePartial=true;
            }
            break;
        }
        outputLinesArr.unshift(line);
        outputBytesCount+=lineBytes;
    }
    if(outputLinesArr.length>=maxLines){
        truncatedBy="lines";
    }
    const outputContent=outputLinesArr.join("\n");
    const finalOutputBytes=Buffer.byteLength(outputContent,"utf-8");
    return {
        content:outputContent,
        truncated:true,
        truncatedBy:truncatedBy,
        totalLines:totalLines,
        totalBytes:totalBytes,
        outputLines:outputLinesArr.length,
        outputBytes:finalOutputBytes,
        lastLinePartial:lastLinePartial,
        firstLineExceedsLimit:false,
        maxLines:maxLines,
        maxBytes:maxBytes,
    };
}
