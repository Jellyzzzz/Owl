import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {expandPath,resolveReadPathAsync,resolveToCwd} from "./path-utils.js";

test("path utils: expands home and normalizes CLI path prefixes",()=>{
    assert.ok(!expandPath("~").includes("~"));
    assert.ok(!expandPath("~/file.txt").includes("~/"));
    assert.equal(expandPath("~draft.md"),"~draft.md");
    assert.equal(expandPath("@~draft.md"),"~draft.md");
    assert.equal(expandPath("file\u00A0name.txt"),"file name.txt");
});

test("path utils: resolves relative paths against cwd",()=>{
    assert.equal(resolveToCwd("a/b.txt","/tmp/work"),resolve("/tmp/work","a/b.txt"));
    assert.equal(resolveToCwd("@a/b.txt","/tmp/work"),resolve("/tmp/work","a/b.txt"));
});

test("path utils: finds macOS-style filename variants",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"owl-path-utils-"));
    try{
        const curly="Capture d\u2019\u00e9cran.txt";
        await writeFile(join(directory,curly),"content");
        assert.equal(
            await resolveReadPathAsync("Capture d'\u00e9cran.txt",directory),
            join(directory,curly),
        );

        const screenshot="Screenshot 10.00.00\u202FAM.png";
        await writeFile(join(directory,screenshot),"content");
        assert.equal(
            await resolveReadPathAsync("Screenshot 10.00.00 AM.png",directory),
            join(directory,screenshot),
        );
    }finally{
        await rm(directory,{recursive:true,force:true});
    }
});
