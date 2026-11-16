import {constants} from "node:fs";
import {access,readFile,writeFile} from "node:fs/promises";
import type{JsonValue} from "../model/types.js";
import type{AgentTool,ToolResult} from "./types.js";
import {
    applyEditsToNormalizedContent,
    detectLineEnding,
    type Edit,
    generateDiffString,
    generateUnifiedPatch,
    normalizeToLF,
    restoreLineEndings,
} from "./edit-diff.js";
import {withFileMutationQueue} from "./file-mutation-queue.js";
import {resolveToCwd} from "./path-utils.js";
import {splitBom} from "./text.js";

interface ReplaceEdit{
    readonly oldText:string;
    readonly newText:string;
}
export interface EditInput{
    readonly path:string;
    readonly edits:readonly ReplaceEdit[];
}
function isSingleEditInput(value:unknown):value is ReplaceEdit{
    if(!value||typeof value!=="object"||Array.isArray(value)){
        return false;
    }
    const edit=value as Record<string,unknown>;
    return typeof edit.oldText==="string"&&typeof edit.newText==="string";
}

/** Accept single edits, JSON-stringified edit arrays, and the legacy oldText/newText shape. */
export function prepareEditArguments(input:unknown):unknown{
    if(!input||typeof input!=="object"||Array.isArray(input)){
        return input;
    }
    const args=input as Record<string,unknown>;

    if(typeof args.edits==="string"){
        try{
            const parsed:unknown=JSON.parse(args.edits);
            if(Array.isArray(parsed)){
                args.edits=parsed;
            }else if(isSingleEditInput(parsed)){
                args.edits=[parsed];
            }
        }catch{
            // Leave malformed input for schema validation to report.
        }
    }else if(isSingleEditInput(args.edits)){
        args.edits=[args.edits];
    }

    const oldText=args.oldText;
    const newText=args.newText;
    if(typeof oldText!=="string"||typeof newText!=="string"){
        return args;
    }
    const edits=Array.isArray(args.edits)?[...args.edits]:[];
    edits.push({oldText:oldText,newText:newText});
    const {oldText:_oldText,newText:_newText,...rest}=args;
    return {...rest,edits:edits};
}

function validateEditInput(input:EditInput):{path:string;edits:Edit[]}{
    if(!Array.isArray(input.edits)||input.edits.length===0){
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    return {path:input.path,edits:input.edits as Edit[]};
}

function editAccessError(path:string,error:unknown):Error{
    const detail=error instanceof Error&&"code" in error
        ?`Error code: ${String(error.code)}`
        :String(error);
    return new Error(`Could not edit file: ${path}. ${detail}.`);
}

export const EditTool:AgentTool={
    definition:{
        name:"edit",
        description:
            "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                path:{
                    type:"string",
                    description:"Path to the file to edit (relative or absolute)",
                },
                edits:{
                    type:"array",
                    description:"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                    items:{
                        type:"object",
                        properties:{
                            oldText:{
                                type:"string",
                                description:"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
                            },
                            newText:{
                                type:"string",
                                description:"Replacement text for this targeted edit.",
                            },
                        },
                        required:["oldText","newText"],
                        additionalProperties:false,
                    },
                },
            },
            required:["path","edits"],
            additionalProperties:false,
        }),
    },
    prepareArguments:prepareEditArguments,

    async execute(args,context):Promise<ToolResult>{
        const input=args as EditInput;
        const {path,edits}=validateEditInput(input);
        const absolutePath=resolveToCwd(path,context.cwd);

        return withFileMutationQueue(absolutePath,async()=>{
            context.signal.throwIfAborted();
            try{
                await access(absolutePath,constants.R_OK|constants.W_OK);
            }catch(error:unknown){
                context.signal.throwIfAborted();
                throw editAccessError(path,error);
            }
            context.signal.throwIfAborted();

            const rawContent=(await readFile(absolutePath)).toString("utf-8");
            context.signal.throwIfAborted();

            const {bom,text:content}=splitBom(rawContent);
            const originalEnding=detectLineEnding(content);
            const normalizedContent=normalizeToLF(content);
            const {baseContent,newContent}=applyEditsToNormalizedContent(normalizedContent,edits,path);
            context.signal.throwIfAborted();

            await writeFile(absolutePath,bom+restoreLineEndings(newContent,originalEnding),"utf-8");
            context.signal.throwIfAborted();

            const diffResult=generateDiffString(baseContent,newContent);
            const firstChangedLine=diffResult.firstChangedLine;
            const details:JsonValue=firstChangedLine===undefined
                ?{diff:diffResult.diff,patch:generateUnifiedPatch(path,baseContent,newContent)}
                :{diff:diffResult.diff,patch:generateUnifiedPatch(path,baseContent,newContent),firstChangedLine:firstChangedLine};
            return {
                content:[{
                    type:"text",
                    text:`Successfully replaced ${edits.length} block(s) in ${path}.`,
                }],
                details:details,
            };
        });
    },
};
