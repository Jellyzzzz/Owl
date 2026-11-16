import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runRipgrep} from "./ripgrep.js";
import {installFakeRipgrep,type FakeRipgrep} from "./fake-ripgrep.js";

let testDir:string;
let fake:FakeRipgrep;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-rg-"));
    fake=await installFakeRipgrep();
});
afterEach(async()=>{
    await fake.restore();
    await rm(testDir,{recursive:true,force:true});
});

test("ripgrep: a hung search is killed and reports a timeout",async()=>{
    fake.setOutput({hang:true});
    await assert.rejects(
        runRipgrep({
            args:["--files"],
            cwd:testDir,
            signal:new AbortController().signal,
            timeoutMs:50,
        }),
        /Search timed out after 1 seconds/,
    );
});

test("ripgrep: cancellation kills the child and preserves the caller reason",async()=>{
    fake.setOutput({hang:true});
    const controller=new AbortController();
    const reason=new Error("User cancelled");
    const running=runRipgrep({
        args:["--files"],
        cwd:testDir,
        signal:controller.signal,
    });
    setTimeout(()=>controller.abort(reason),50);
    await assert.rejects(running,error=>error===reason);
});

test("ripgrep: missing executable explains how to install it",async()=>{
    process.env.OWL_RG_PATH=join(testDir,"missing-rg");
    await assert.rejects(
        runRipgrep({
            args:["--files"],
            cwd:testDir,
            signal:new AbortController().signal,
        }),
        /ripgrep \(rg\) is required.*brew install ripgrep/s,
    );
});
