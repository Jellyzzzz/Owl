import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolContext,ToolResult} from "./types.js";
import {GrepTool} from "./grep.js";
import {
    installFakeRipgrep,
    ripgrepEvent,
    type FakeRipgrep,
} from "./fake-ripgrep.js";

let testDir:string;
let fake:FakeRipgrep;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-grep-"));
    fake=await installFakeRipgrep();
});
afterEach(async()=>{
    await fake.restore();
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
function filePath(name:string):string{
    return join(testDir,name);
}

test("grep: returns matching lines with relative paths and line numbers",async()=>{
    fake.setOutput({
        events:[
            ripgrepEvent("match",filePath("docs/notes.md"),1,"alpha"),
            ripgrepEvent("match",filePath("src/a.ts"),1,"const alpha = 1;"),
        ],
    });
    const result=await GrepTool.execute({pattern:"alpha"},createContext());
    assert.equal(text(result),"docs/notes.md:1: alpha\nsrc/a.ts:1: const alpha = 1;");
});

test("grep: includes context before and after matches",async()=>{
    fake.setOutput({
        events:[
            ripgrepEvent("context",filePath("src/a.ts"),1,"const alpha = 1;"),
            ripgrepEvent("match",filePath("src/a.ts"),2,"const beta = 2;"),
            ripgrepEvent("context",filePath("src/a.ts"),3,"const gamma = 3;"),
        ],
    });
    const result=await GrepTool.execute({pattern:"beta",context:1},createContext());
    assert.equal(text(result),[
        "src/a.ts-1- const alpha = 1;",
        "src/a.ts:2: const beta = 2;",
        "src/a.ts-3- const gamma = 3;",
    ].join("\n"));
});

test("grep: reports the match limit only when another match exists",async()=>{
    fake.setOutput({
        events:[
            ripgrepEvent("match",filePath("a.ts"),1,"alpha"),
            ripgrepEvent("match",filePath("b.ts"),1,"alpha"),
        ],
    });
    const result=await GrepTool.execute({pattern:"alpha",limit:1},createContext());
    assert.match(text(result),/^a\.ts:1: alpha\n\n\[1 matches limit reached/);
    assert.equal((result.details as {matchLimitReached?:number}|undefined)?.matchLimitReached,1);
});

test("grep: does not report the limit when the last match exactly reaches it",async()=>{
    fake.setOutput({
        events:[ripgrepEvent("match",filePath("a.ts"),1,"alpha")],
    });
    const result=await GrepTool.execute({pattern:"alpha",limit:1},createContext());
    assert.equal(text(result),"a.ts:1: alpha");
    assert.equal(result.details,undefined);
});

test("grep: truncates long lines and reports it",async()=>{
    const file=filePath("src/long.ts");
    await mkdir(join(testDir,"src"),{recursive:true});
    await writeFile(file,`${"x".repeat(600)} needle\n`);
    fake.setOutput({
        events:[ripgrepEvent("match",file,1,`${"x".repeat(600)} needle`)],
    });
    const result=await GrepTool.execute({pattern:"needle",path:"src/long.ts"},createContext());
    assert.match(text(result),/\[truncated\]/);
    assert.equal((result.details as {linesTruncated?:boolean}|undefined)?.linesTruncated,true);
});

test("grep: searches a single file using its basename",async()=>{
    const file=filePath("src/a.ts");
    await mkdir(join(testDir,"src"),{recursive:true});
    await writeFile(file,"const beta = 2;\n");
    fake.setOutput({events:[ripgrepEvent("match",file,2,"const beta = 2;")]});
    const result=await GrepTool.execute({pattern:"beta",path:"src/a.ts"},createContext());
    assert.equal(text(result),"a.ts:2: const beta = 2;");
});

test("grep: reports no matches",async()=>{
    fake.setOutput({exitCode:1});
    const result=await GrepTool.execute({pattern:"not-present"},createContext());
    assert.equal(text(result),"No matches found");
    assert.equal(result.details,undefined);
});

test("grep: execution errors are surfaced instead of reported as no matches",async()=>{
    fake.setOutput({exitCode:2,stderr:"rg: regex parse error: unclosed character class"});
    await assert.rejects(
        GrepTool.execute({pattern:"["},createContext()),
        /ripgrep failed: rg: regex parse error/,
    );
});

test("grep: partial results are marked incomplete",async()=>{
    fake.setOutput({
        events:[ripgrepEvent("match",filePath("a.ts"),1,"alpha")],
        exitCode:2,
        stderr:"rg: ./secret: Permission denied",
    });
    const result=await GrepTool.execute({pattern:"alpha"},createContext());
    assert.match(text(result),/^a\.ts:1: alpha/);
    assert.match(text(result),/Search incomplete: ripgrep reported 1 error/);
    assert.equal((result.details as {incomplete?:boolean}|undefined)?.incomplete,true);
    assert.equal((result.details as {errorCount?:number}|undefined)?.errorCount,1);
});

test("grep: missing paths produce a clear error",async()=>{
    await assert.rejects(
        GrepTool.execute({pattern:"alpha",path:"missing"},createContext()),
        /Path not found:/,
    );
});

test("grep: rejects fractional and out-of-range limits",async()=>{
    await assert.rejects(GrepTool.execute({pattern:"alpha",limit:0.5},createContext()),/limit must be an integer/);
    await assert.rejects(GrepTool.execute({pattern:"alpha",limit:0},createContext()),/limit must be an integer/);
    await assert.rejects(GrepTool.execute({pattern:"alpha",context:1.5},createContext()),/context must be an integer/);
});

test("grep: passes structured arguments to ripgrep without a shell",async()=>{
    const argsFile=join(testDir,"args.json");
    await mkdir(join(testDir,"src"),{recursive:true});
    fake.setOutput({argsFile:argsFile});
    const pattern="alpha; echo injected";
    await GrepTool.execute({
        pattern:pattern,
        path:"src",
        glob:"*.ts",
        ignoreCase:true,
        literal:true,
        context:2,
        limit:5,
    },createContext());
    const args=JSON.parse(await readFile(argsFile,"utf8")) as string[];
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--no-config"));
    assert.ok(args.includes("--no-require-git"));
    assert.ok(args.includes("--hidden"));
    assert.ok(args.includes("--ignore-case"));
    assert.ok(args.includes("--fixed-strings"));
    assert.deepEqual(args.slice(args.indexOf("--glob"),args.indexOf("--glob")+2),["--glob","*.ts"]);
    assert.deepEqual(args.slice(args.indexOf("--context"),args.indexOf("--context")+2),["--context","2"]);
    assert.deepEqual(args.slice(args.indexOf("-e"),args.indexOf("-e")+2),["-e",pattern]);
    assert.equal(args[args.length-2],"--");
});

test("grep: missing ripgrep produces an installation hint",async()=>{
    process.env.OWL_RG_PATH=join(testDir,"missing-rg");
    await assert.rejects(
        GrepTool.execute({pattern:"alpha"},createContext()),
        /ripgrep \(rg\) is required.*brew install ripgrep/s,
    );
});
