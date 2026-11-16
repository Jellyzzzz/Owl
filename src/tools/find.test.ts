import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolContext,ToolResult} from "./types.js";
import {FindTool} from "./find.js";
import {installFakeRipgrep,type FakeRipgrep} from "./fake-ripgrep.js";

let testDir:string;
let fake:FakeRipgrep;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-find-"));
    await mkdir(join(testDir,"src"),{recursive:true});
    fake=await installFakeRipgrep();
});
afterEach(async()=>{
    await fake.restore();
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
function filePath(name:string):string{
    return join(testDir,name);
}

test("find: basename patterns match at any depth, including hidden directories",async()=>{
    fake.setOutput({files:[
        filePath("src/a.ts"),
        filePath("src/nested/b.ts"),
        filePath("src/c.js"),
        filePath("docs/d.md"),
        filePath(".hidden/hidden.ts"),
    ]});
    const result=await FindTool.execute({pattern:"*.ts",path:"."},createContext());
    assert.equal(text(result),".hidden/hidden.ts\nsrc/a.ts\nsrc/nested/b.ts");
});

test("find: path-containing patterns are relative to the search root",async()=>{
    fake.setOutput({files:[
        filePath("src/a.ts"),
        filePath("src/nested/b.ts"),
        filePath("docs/d.md"),
    ]});
    const result=await FindTool.execute({pattern:"src/**/*.ts",path:"."},createContext());
    assert.equal(text(result),"src/a.ts\nsrc/nested/b.ts");
});

test("find: searches a specific directory and returns paths relative to it",async()=>{
    fake.setOutput({files:[
        filePath("src/a.ts"),
        filePath("src/nested/b.ts"),
        filePath("docs/d.md"),
    ]});
    const result=await FindTool.execute({pattern:"**/*.ts",path:"src"},createContext());
    assert.equal(text(result),"a.ts\nnested/b.ts");
});

test("find: reports the result limit only when another result exists",async()=>{
    fake.setOutput({files:[filePath("src/a.ts"),filePath("src/b.ts")]});
    const result=await FindTool.execute({pattern:"*.ts",path:"src",limit:1},createContext());
    assert.match(text(result),/^a\.ts\n\n\[1 results limit reached\. Use limit=2/);
    assert.equal((result.details as {resultLimitReached?:number}|undefined)?.resultLimitReached,1);
});

test("find: does not report the limit when the last result exactly reaches it",async()=>{
    fake.setOutput({files:[filePath("src/a.ts")]});
    const result=await FindTool.execute({pattern:"*.ts",path:"src",limit:1},createContext());
    assert.equal(text(result),"a.ts");
    assert.equal(result.details,undefined);
});

test("find: searches a single file",async()=>{
    const file=filePath("src/a.ts");
    await mkdir(join(testDir,"src"),{recursive:true});
    await writeFile(file,"export const a = 1;\n");
    const result=await FindTool.execute({pattern:"*.ts",path:"src/a.ts"},createContext());
    assert.equal(text(result),"a.ts");
});

test("find: reports no matches",async()=>{
    fake.setOutput({files:[filePath("src/a.ts")]});
    const result=await FindTool.execute({pattern:"*.rs",path:"."},createContext());
    assert.equal(text(result),"No files found matching pattern");
    assert.equal(result.details,undefined);
});

test("find: partial results are marked incomplete",async()=>{
    fake.setOutput({
        files:[filePath("src/a.ts")],
        exitCode:2,
        stderr:"rg: ./secret: Permission denied",
    });
    const result=await FindTool.execute({pattern:"*.ts",path:"src"},createContext());
    assert.match(text(result),/^a\.ts/);
    assert.match(text(result),/Search incomplete: ripgrep reported 1 error/);
    assert.equal((result.details as {incomplete?:boolean}|undefined)?.incomplete,true);
});

test("find: missing paths produce a clear error",async()=>{
    await assert.rejects(
        FindTool.execute({pattern:"*.ts",path:"missing"},createContext()),
        /Path not found:/,
    );
});

test("find: rejects fractional and out-of-range limits",async()=>{
    await assert.rejects(FindTool.execute({pattern:"*.ts",limit:0.5},createContext()),/limit must be an integer/);
    await assert.rejects(FindTool.execute({pattern:"*.ts",limit:0},createContext()),/limit must be an integer/);
});

test("find: passes structured arguments to ripgrep",async()=>{
    const argsFile=join(testDir,"args.json");
    fake.setOutput({argsFile:argsFile});
    await FindTool.execute({pattern:"*.ts",path:"."},createContext());
    const args=JSON.parse(await readFile(argsFile,"utf8")) as string[];
    assert.ok(args.includes("--files"));
    assert.ok(args.includes("--hidden"));
    assert.ok(args.includes("--no-config"));
    assert.ok(args.includes("--no-require-git"));
    assert.ok(args.includes("--null"));
    assert.deepEqual(args.slice(args.indexOf("--sort"),args.indexOf("--sort")+2),["--sort","path"]);
    assert.equal(args[args.length-2],"--");
    assert.equal(args[args.length-1],testDir);
});

test("find: missing ripgrep produces an installation hint",async()=>{
    process.env.OWL_RG_PATH=join(testDir,"missing-rg");
    await assert.rejects(
        FindTool.execute({pattern:"*.ts"},createContext()),
        /ripgrep \(rg\) is required.*brew install ripgrep/s,
    );
});
