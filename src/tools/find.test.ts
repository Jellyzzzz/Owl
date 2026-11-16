import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import type{ToolContext,ToolResult} from "./types.js";
import {FindTool} from "./find.js";

const execFileAsync=promisify(execFile);

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-find-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext():ToolContext{
    return {callId:"call-find",cwd:testDir,signal:new AbortController().signal};
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}
async function fixture():Promise<void>{
    await mkdir(join(testDir,"src","nested"),{recursive:true});
    await mkdir(join(testDir,"docs"),{recursive:true});
    await mkdir(join(testDir,"node_modules","pkg"),{recursive:true});
    await mkdir(join(testDir,".hidden"),{recursive:true});
    await writeFile(join(testDir,"src","a.ts"),"export const a = 1;\n");
    await writeFile(join(testDir,"src","nested","b.ts"),"export const b = 2;\n");
    await writeFile(join(testDir,"src","c.js"),"export const c = 3;\n");
    await writeFile(join(testDir,"docs","d.md"),"# docs\n");
    await writeFile(join(testDir,"node_modules","pkg","ignored.ts"),"export const ignored = true;\n");
    await writeFile(join(testDir,".hidden","hidden.ts"),"export const hidden = true;\n");
}

test("find: basename patterns match at any depth and skip node_modules",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"*.ts",path:"."},createContext());
    assert.equal(text(result),".hidden/hidden.ts\nsrc/a.ts\nsrc/nested/b.ts");
});

test("find: path-containing patterns are relative to the search root",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"src/**/*.ts",path:"."},createContext());
    assert.equal(text(result),"src/a.ts\nsrc/nested/b.ts");
});

test("find: searches a specific directory and returns paths relative to it",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"**/*.ts",path:"src"},createContext());
    assert.equal(text(result),"a.ts\nnested/b.ts");
});

test("find: reports the result limit and truncates the result set",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"*.ts",path:"src",limit:1},createContext());
    assert.match(text(result),/^a\.ts\n\n\[1 results limit reached\. Use limit=2/);
    assert.equal((result.details as {resultLimitReached?:number}|undefined)?.resultLimitReached,1);
});

test("find: searches a single file",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"*.ts",path:"src/a.ts"},createContext());
    assert.equal(text(result),"a.ts");
});

test("find: reports no matches",async()=>{
    await fixture();
    const result=await FindTool.execute({pattern:"*.rs",path:"."},createContext());
    assert.equal(text(result),"No files found matching pattern");
    assert.equal(result.details,undefined);
});

test("find: respects .gitignore in a git repository",async()=>{
    await execFileAsync("git",["init","-q",testDir]);
    await writeFile(join(testDir,".gitignore"),"ignored.ts\n");
    await writeFile(join(testDir,"kept.ts"),"export const kept = true;\n");
    await writeFile(join(testDir,"ignored.ts"),"export const ignored = true;\n");

    const result=await FindTool.execute({pattern:"*.ts",path:"."},createContext());
    assert.equal(text(result),"kept.ts");
});

test("find: missing paths produce a clear error",async()=>{
    await assert.rejects(
        FindTool.execute({pattern:"*.ts",path:"missing"},createContext()),
        /Path not found:/,
    );
});
