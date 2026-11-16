import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolContext,ToolResult} from "./types.js";
import {GrepTool} from "./grep.js";

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-grep-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext():ToolContext{
    return {callId:"call-grep",cwd:testDir,signal:new AbortController().signal};
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}
async function fixture():Promise<void>{
    await mkdir(join(testDir,"src"),{recursive:true});
    await mkdir(join(testDir,"docs"),{recursive:true});
    await mkdir(join(testDir,"node_modules"),{recursive:true});
    await writeFile(join(testDir,"src","a.ts"),"const alpha = 1;\nconst beta = 2;\n");
    await writeFile(join(testDir,"src","b.ts"),"ALPHA\n");
    await writeFile(join(testDir,"docs","notes.md"),"alpha\n");
    await writeFile(join(testDir,"node_modules","ignored.ts"),"alpha\n");
    await writeFile(join(testDir,"src","long.ts"),`${"x".repeat(600)} needle\n`);
}

test("grep: returns matching lines with relative paths and line numbers",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"alpha"},createContext());
    assert.equal(text(result),"docs/notes.md:1: alpha\nsrc/a.ts:1: const alpha = 1;");
});

test("grep: supports case-insensitive searches",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"alpha",ignoreCase:true},createContext());
    assert.match(text(result),/src\/b\.ts:1: ALPHA/);
    assert.match(text(result),/docs\/notes\.md:1: alpha/);
});

test("grep: supports literal searches",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"alpha = 1",literal:true},createContext());
    assert.equal(text(result),"src/a.ts:1: const alpha = 1;");
});

test("grep: filters files with a glob",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"alpha",glob:"*.ts"},createContext());
    assert.equal(text(result),"src/a.ts:1: const alpha = 1;");
});

test("grep: includes context lines",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"beta",context:1},createContext());
    assert.match(text(result),/src\/a\.ts-1- const alpha = 1;/);
    assert.match(text(result),/src\/a\.ts:2: const beta = 2;/);
});

test("grep: reports the match limit",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"alpha",limit:1},createContext());
    assert.match(text(result),/^docs\/notes\.md:1: alpha\n\n\[1 matches limit reached/);
    assert.equal((result.details as {matchLimitReached?:number}|undefined)?.matchLimitReached,1);
});

test("grep: truncates long lines and reports it",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"needle",path:"src/long.ts"},createContext());
    assert.match(text(result),/\[truncated\]/);
    assert.equal((result.details as {linesTruncated?:boolean}|undefined)?.linesTruncated,true);
});

test("grep: searches a single file using its basename",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"beta",path:"src/a.ts"},createContext());
    assert.equal(text(result),"a.ts:2: const beta = 2;");
});

test("grep: reports no matches",async()=>{
    await fixture();
    const result=await GrepTool.execute({pattern:"not-present"},createContext());
    assert.equal(text(result),"No matches found");
    assert.equal(result.details,undefined);
});

test("grep: invalid regular expressions produce a clear error",async()=>{
    await fixture();
    await assert.rejects(
        GrepTool.execute({pattern:"["},createContext()),
        /Invalid regular expression:/,
    );
});

test("grep: missing paths produce a clear error",async()=>{
    await assert.rejects(
        GrepTool.execute({pattern:"alpha",path:"missing"},createContext()),
        /Path not found:/,
    );
});
