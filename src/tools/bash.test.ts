import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,stat,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolContext,ToolResult} from "./types.js";
import {BashTool} from "./bash.js";

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-bash-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext():ToolContext{
    return {callId:"call-bash",cwd:testDir,signal:new AbortController().signal};
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}
function fullOutputPath(result:ToolResult):string|undefined{
    const match=/\[Output truncated\. Full captured output: ([^\]]+)\]/.exec(text(result));
    return match?.[1];
}

test("bash: truncated updates and final output expose the full output path",async()=>{
    const updates:ToolResult[]=[];
    const padding="0123456789".repeat(6);
    const command=`yes '${padding}' | head -n 5000`;
    const result=await BashTool.execute(
        {command:command,timeout:10},
        createContext(),
        update=>updates.push(update),
    );
    const path=fullOutputPath(result);
    try{
        assert.ok(path,"final result should include the full output path");
        assert.ok((await stat(path)).isFile());
        assert.ok(updates.length>0,"bash should emit at least one progress update");
        const lastUpdate=updates.at(-1);
        assert.ok(lastUpdate);
        assert.equal(fullOutputPath(lastUpdate),path);
    }finally{
        if(path!==undefined){
            await unlink(path).catch(()=>{});
        }
    }
});
