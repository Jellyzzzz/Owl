import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {applyPatch} from "diff";
import type{ToolCallBlock} from "../model/types.js";
import {readToolResult} from "../model/tool-result.js";
import {ToolRegistry} from "./registry.js";
import type{ToolContext,ToolResult} from "./types.js";
import {EditTool} from "./edit.js";

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-edit-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext(cwd=testDir,signal=new AbortController().signal):ToolContext{
    return {callId:"call-1",cwd:cwd,signal:signal};
}
async function edit(args:unknown,context=createContext()):Promise<ToolResult>{
    return EditTool.execute(args,context);
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}
function detailsOf(result:ToolResult):{diff:string;patch:string;firstChangedLine?:number}{
    return result.details as {diff:string;patch:string;firstChangedLine?:number};
}

test("edit: replaces exact text and returns a compact model-visible result",async()=>{
    const file=join(testDir,"edit.txt");
    await writeFile(file,"Hello, world!");

    const result=await edit({path:file,edits:[{oldText:"world",newText:"testing"}]});
    assert.equal(await readFile(file,"utf-8"),"Hello, testing!");
    assert.equal(result.content.length,1);
    assert.ok(text(result).startsWith("Successfully replaced 1 block(s)"));
    assert.ok(!text(result).includes("\n"));
    const details=detailsOf(result);
    assert.ok(details.diff.includes("testing"));
    assert.ok(details.patch.includes("-Hello, world!"));
    assert.ok(details.patch.includes("+Hello, testing!"));
    assert.equal(applyPatch("Hello, world!",details.patch),"Hello, testing!");
    assert.equal(details.firstChangedLine,1);
});

test("edit: fails when oldText is not present",async()=>{
    const file=join(testDir,"missing-text.txt");
    await writeFile(file,"Hello, world!");
    await assert.rejects(
        edit({path:file,edits:[{oldText:"nonexistent",newText:"testing"}]}),
        /Could not find the exact text/,
    );
});

test("edit: reports ENOENT when the target does not exist",async()=>{
    const file=join(testDir,"missing.txt");
    await assert.rejects(
        edit({path:file,edits:[{oldText:"hello",newText:"world"}]}),
        new RegExp(`Could not edit file: ${file.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\. Error code: ENOENT\\.`),
    );
});

test("edit: rejects duplicate matches",async()=>{
    const file=join(testDir,"duplicate.txt");
    await writeFile(file,"foo foo foo");
    await assert.rejects(
        edit({path:file,edits:[{oldText:"foo",newText:"bar"}]}),
        /Found 3 occurrences/,
    );
});

test("edit: applies multiple disjoint regions in one call",async()=>{
    const file=join(testDir,"multi.txt");
    await writeFile(file,"alpha\nbeta\ngamma\ndelta\n");
    const result=await edit({
        path:file,
        edits:[
            {oldText:"alpha\n",newText:"ALPHA\n"},
            {oldText:"gamma\n",newText:"GAMMA\n"},
        ],
    });
    assert.equal(await readFile(file,"utf-8"),"ALPHA\nbeta\nGAMMA\ndelta\n");
    assert.ok(text(result).includes("Successfully replaced 2 block(s)"));
    assert.ok(detailsOf(result).diff.includes("ALPHA"));
    assert.ok(detailsOf(result).diff.includes("GAMMA"));
});

test("edit: matches all edits against the original file",async()=>{
    const file=join(testDir,"original.txt");
    await writeFile(file,"foo\nbar\nbaz\n");
    await edit({
        path:file,
        edits:[
            {oldText:"foo\n",newText:"foo bar\n"},
            {oldText:"bar\n",newText:"BAR\n"},
        ],
    });
    assert.equal(await readFile(file,"utf-8"),"foo bar\nBAR\nbaz\n");
});

test("edit: rejects overlapping edits",async()=>{
    const file=join(testDir,"overlap.txt");
    await writeFile(file,"one\ntwo\nthree\n");
    await assert.rejects(
        edit({
            path:file,
            edits:[
                {oldText:"one\ntwo\n",newText:"ONE\nTWO\n"},
                {oldText:"two\nthree\n",newText:"TWO\nTHREE\n"},
            ],
        }),
        /overlap/,
    );
});

test("edit: does not partially apply a failing batch",async()=>{
    const file=join(testDir,"partial.txt");
    const original="alpha\nbeta\ngamma\n";
    await writeFile(file,original);
    await assert.rejects(
        edit({
            path:file,
            edits:[
                {oldText:"alpha\n",newText:"ALPHA\n"},
                {oldText:"missing\n",newText:"MISSING\n"},
            ],
        }),
        /Could not find/,
    );
    assert.equal(await readFile(file,"utf-8"),original);
});

test("edit: rejects empty edits, empty oldText and no-op replacements",async()=>{
    const file=join(testDir,"invalid.txt");
    await writeFile(file,"hello\nworld\n");
    await assert.rejects(
        edit({path:file,edits:[]}),
        /edits must contain at least one replacement/,
    );
    await assert.rejects(
        edit({path:file,edits:[{oldText:"",newText:"x"}]}),
        /oldText must not be empty/,
    );
    await assert.rejects(
        edit({path:file,edits:[{oldText:"hello",newText:"hello"}]}),
        /No changes made to/,
    );
});

test("edit: collapses large unchanged gaps in the details diff",async()=>{
    const file=join(testDir,"large-gap.txt");
    const lines=Array.from({length:600},(_,index)=>`line ${String(index+1).padStart(3,"0")}`);
    await writeFile(file,`${lines.join("\n")}\n`);
    const result=await edit({
        path:file,
        edits:[
            {oldText:"line 100\n",newText:"LINE 100\n"},
            {oldText:"line 300\n",newText:"LINE 300\n"},
            {oldText:"line 500\n",newText:"LINE 500\n"},
        ],
    });
    const diff=detailsOf(result).diff;
    assert.ok(diff.includes("LINE 100"));
    assert.ok(diff.includes("LINE 300"));
    assert.ok(diff.includes("LINE 500"));
    assert.ok(diff.includes("..."));
    assert.ok(!diff.includes("line 250"));
    assert.ok(diff.split("\n").length<50);
});

test("edit: preserves BOM and CRLF line endings",async()=>{
    const file=join(testDir,"bom-crlf.txt");
    await writeFile(file,"\uFEFFalpha\r\nbeta\r\ngamma\r\n");
    await edit({path:file,edits:[{oldText:"beta",newText:"BETA"}]});
    assert.equal(await readFile(file,"utf-8"),"\uFEFFalpha\r\nBETA\r\ngamma\r\n");
});

test("edit: fuzzy matches trailing whitespace without rewriting untouched lines",async()=>{
    const file=join(testDir,"fuzzy.txt");
    await writeFile(file,"alpha   \nbeta\ngamma\n");
    await edit({path:file,edits:[{oldText:"alpha\nbeta",newText:"ALPHA\nbeta"}]});
    assert.equal(await readFile(file,"utf-8"),"ALPHA\nbeta\ngamma\n");
});

test("edit: serializes concurrent edits to the same file",async()=>{
    const file=join(testDir,"concurrent.txt");
    await writeFile(file,"a\nb\n");
    await Promise.all([
        edit({path:file,edits:[{oldText:"a",newText:"A"}]}),
        edit({path:file,edits:[{oldText:"b",newText:"B"}]}),
    ]);
    assert.equal(await readFile(file,"utf-8"),"A\nB\n");
});

test("edit: read-only files report EACCES",{skip:process.platform==="win32"||process.getuid?.()===0},async()=>{
    const file=join(testDir,"readonly.txt");
    await writeFile(file,"hello\n");
    await chmod(file,0o444);
    try{
        await assert.rejects(
            edit({path:file,edits:[{oldText:"hello",newText:"world"}]}),
            new RegExp(`Could not edit file: ${file.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\. Error code: EACCES\\.`),
        );
    }finally{
        await chmod(file,0o644);
    }
});

test("edit: cancellation before execution propagates the abort reason",async()=>{
    const controller=new AbortController();
    const reason=new Error("User cancelled");
    controller.abort(reason);
    await assert.rejects(
        edit({path:"anything.txt",edits:[{oldText:"a",newText:"b"}]},createContext(testDir,controller.signal)),
        error=>error===reason,
    );
});

test("edit: registry normalizes single, JSON-string and legacy edit arguments",async()=>{
    const cases:unknown[]=[
        {edits:{oldText:"alpha",newText:"ALPHA"}},
        {edits:JSON.stringify([{oldText:"alpha",newText:"ALPHA"}])},
        {oldText:"alpha",newText:"ALPHA"},
    ];
    for(const [index,extra] of cases.entries()){
        const file=join(testDir,`prepare-${index}.txt`);
        await writeFile(file,"alpha\nbeta\n");
        const registry=new ToolRegistry();
        registry.register(EditTool);
        const call:ToolCallBlock={
            type:"tool_call",
            callId:`call-${index}`,
            name:"edit",
            argumentsJson:JSON.stringify({path:file,...(extra as Record<string,unknown>)}),
        };
        const execution=await registry.execute(call,testDir,new AbortController().signal);
        const {result,content}=readToolResult(execution.message);
        assert.equal(result.isError,false);
        assert.equal(content.filter(block=>block.type==="text").map(block=>block.text).join(""),`Successfully replaced 1 block(s) in ${file}.`);
        assert.equal(await readFile(file,"utf-8"),"ALPHA\nbeta\n");
        assert.ok(execution.details!==undefined);
    }
});

test("edit: registry keeps the diff out of the model-visible tool message",async()=>{
    const file=join(testDir,"token.txt");
    await writeFile(file,`${Array.from({length:400},(_,index)=>`line ${index+1}`).join("\n")}\n`);
    const registry=new ToolRegistry();
    registry.register(EditTool);
    const call:ToolCallBlock={
        type:"tool_call",
        callId:"call-token",
        name:"edit",
        argumentsJson:JSON.stringify({path:file,edits:[{oldText:"line 200\n",newText:"LINE 200\n"}]}),
    };
    const execution=await registry.execute(call,testDir,new AbortController().signal);
    const {result,content}=readToolResult(execution.message);
    assert.equal(result.isError,false);
    const visible=content.filter(block=>block.type==="text").map(block=>block.text).join("");
    assert.ok(visible.length<120);
    assert.ok(!visible.includes("LINE 200"));
    const details=execution.details as {diff:string;patch:string};
    assert.ok(details.diff.includes("LINE 200"));
    assert.ok(details.patch.includes("+LINE 200"));
});
