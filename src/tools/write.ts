import {mkdir,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import type{AgentTool,ToolResult} from "./types.js";
import {withFileMutationQueue} from "./file-mutation-queue.js";
import {resolveToCwd} from "./path-utils.js";

interface WriteInput{
    readonly path:string;
    readonly content:string;
}

export const WriteTool:AgentTool={
    definition:{
        name:"write",
        description:
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
        parametersJson:JSON.stringify({
            type:"object",
            properties:{
                path:{
                    type:"string",
                    description:"Path to the file to write (relative or absolute)",
                },
                content:{
                    type:"string",
                    description:"Content to write to the file",
                },
            },
            required:["path","content"],
            additionalProperties:false,
        }),
    },

    async execute(args,context):Promise<ToolResult>{
        const input=args as WriteInput;
        const absolutePath=resolveToCwd(input.path,context.cwd);
        const directory=dirname(absolutePath);

        return withFileMutationQueue(absolutePath,async()=>{
            context.signal.throwIfAborted();
            await mkdir(directory,{recursive:true});
            context.signal.throwIfAborted();

            await writeFile(absolutePath,input.content,"utf-8");
            context.signal.throwIfAborted();

            return {
                content:[{
                    type:"text",
                    text:`Successfully wrote to ${input.path}`,
                }],
            };
        });
    },
};
