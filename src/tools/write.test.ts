import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolCallBlock} from "../model/types.js";
import {readToolResult} from "../model/tool-result.js";
import {ToolRegistry} from "./registry.js";
import type{ToolContext,ToolResult} from "./types.js";
import {WriteTool} from "./write.js";

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-write-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext(cwd=testDir,signal=new AbortController().signal):ToolContext{
    return {callId:"call-1",cwd:cwd,signal:signal};
}
async function write(args:unknown,context=createContext()):Promise<ToolResult>{
    return WriteTool.execute(args,context);
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}

test("write: writes file contents and returns one compact status line",async()=>{
    const file=join(testDir,"write-test.txt");
    const result=await write({path:file,content:"Test content"});

    assert.equal(await readFile(file,"utf-8"),"Test content");
    assert.equal(text(result),`Successfully wrote to ${file}`);
    assert.equal(result.content.length,1);
    assert.equal(result.details,undefined);
});

test("write: creates missing parent directories",async()=>{
    const file=join(testDir,"nested","dir","test.txt");
    const result=await write({path:file,content:"Nested content"});

    assert.equal(await readFile(file,"utf-8"),"Nested content");
    assert.equal(text(result),`Successfully wrote to ${file}`);
    assert.ok((await stat(join(testDir,"nested","dir"))).isDirectory());
});

test("write: overwrites existing content completely",async()=>{
    const file=join(testDir,"overwrite.txt");
    await writeFile(file,"this content is much longer than the replacement");
    await write({path:file,content:"short"});
    assert.equal(await readFile(file,"utf-8"),"short");
});

test("write: writes empty files",async()=>{
    const file=join(testDir,"empty.txt");
    await write({path:file,content:""});
    assert.equal(await readFile(file,"utf-8"),"");
});

test("write: preserves content bytes, CRLF, BOM and missing trailing newline",async()=>{
    const file=join(testDir,"exact.txt");
    const content="\uFEFFalpha\r\nbeta\ngamma";
    await write({path:file,content:content});
    assert.equal(await readFile(file,"utf-8"),content);
});

test("write: resolves relative paths against the tool context cwd",async()=>{
    const result=await write({path:"@relative.txt",content:"relative content"});
    assert.equal(await readFile(join(testDir,"relative.txt"),"utf-8"),"relative content");
    assert.equal(text(result),"Successfully wrote to @relative.txt");
});

test("write: cancellation before execution propagates the abort reason",async()=>{
    const controller=new AbortController();
    const reason=new Error("User cancelled");
    controller.abort(reason);
    const file=join(testDir,"cancelled.txt");
    await assert.rejects(
        write({path:file,content:"should not exist"},createContext(testDir,controller.signal)),
        error=>error===reason,
    );
    await assert.rejects(stat(file),/ENOENT/);
});

test("write: registry executes the tool and exposes only the status text to the model",async()=>{
    const file=join(testDir,"registry.txt");
    const registry=new ToolRegistry();
    registry.register(WriteTool);
    const call:ToolCallBlock={
        type:"tool_call",
        callId:"call-write",
        name:"write",
        argumentsJson:JSON.stringify({path:file,content:"registry content"}),
    };
    const execution=await registry.execute(call,testDir,new AbortController().signal);
    const {result,content}=readToolResult(execution.message);
    assert.equal(result.isError,false);
    assert.equal(
        content.filter(block=>block.type==="text").map(block=>block.text).join(""),
        `Successfully wrote to ${file}`,
    );
    assert.equal(await readFile(file,"utf-8"),"registry content");
    assert.equal(execution.details,undefined);
});
