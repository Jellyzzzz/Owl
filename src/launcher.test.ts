import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {chmod,copyFile,mkdir,mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,relative} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const launcher=fileURLToPath(new URL("../bin/owl",import.meta.url));
const cli=fileURLToPath(new URL("./cli.ts",import.meta.url));

test("launcher resolves symlinks without changing cwd or splitting arguments",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"owl launcher "));
    try{
        const install=join(dir,"owl installation");
        const workspace=join(dir,"project space");
        const config=join(dir,"config space");
        const fakeBin=join(dir,"fake bin");
        const link=join(dir,"links","owl");
        await Promise.all([
            mkdir(join(install,"bin"),{recursive:true}),
            mkdir(join(install,"node_modules/tsx/dist"),{recursive:true}),
            mkdir(join(install,"src"),{recursive:true}),
            mkdir(join(config,"owl"),{recursive:true}),
            mkdir(fakeBin,{recursive:true}),mkdir(workspace,{recursive:true}),mkdir(dirname(link),{recursive:true}),
        ]);
        await copyFile(launcher,join(install,"bin/owl"));
        await chmod(join(install,"bin/owl"),0o755);
        await writeFile(join(install,"node_modules/tsx/dist/loader.mjs"),"");
        await writeFile(join(install,"src/cli.ts"),"");
        await writeFile(join(install,".env.local"),"OLD=1\n");
        await writeFile(join(config,"owl/env"),"NEW=1\n");
        await writeFile(join(fakeBin,"node"),'#!/bin/sh\npwd -P\nprintf "%s\\n" "$@"\n',{mode:0o755});
        await symlink(relative(dirname(link),join(install,"bin/owl")),link);
        const env={...process.env,PATH:`${fakeBin}:${process.env.PATH}`,XDG_CONFIG_HOME:config};
        const result=spawnSync(link,["--session","path with spaces"],{cwd:workspace,env,encoding:"utf8"});
        assert.equal(result.status,0,result.stderr);
        const lines=result.stdout.trimEnd().split("\n");
        assert.equal(lines[0],realpathSync(workspace));
        const physicalInstall=realpathSync(install);
        assert.deepEqual(lines.slice(1),[
            `--env-file=${join(config,"owl/env")}`,"--import",
            join(physicalInstall,"node_modules/tsx/dist/loader.mjs"),
            join(physicalInstall,"src/cli.ts"),"--session","path with spaces",
        ]);
        await rm(join(config,"owl/env"));
        const fallback=spawnSync(link,[],{cwd:workspace,env,encoding:"utf8"});
        assert.equal(fallback.status,0,fallback.stderr);
        assert.ok(fallback.stdout.includes(`--env-file=${join(physicalInstall,".env.local")}`));
        await rm(join(install,".env.local"));
        const noFile=spawnSync(link,[],{cwd:workspace,env,encoding:"utf8"});
        assert.equal(noFile.status,0,noFile.stderr);
        assert.ok(!noFile.stdout.includes("--env-file="));
        await rm(join(install,"node_modules/tsx/dist/loader.mjs"));
        const missing=spawnSync(link,[],{cwd:workspace,env,encoding:"utf8"});
        assert.equal(missing.status,1);
        assert.match(missing.stderr,/dependencies are missing; run npm ci/);
    }finally{
        await rm(dir,{recursive:true,force:true});
    }
});

test("real launcher loads user config and resumes a session for the caller's workspace",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"owl-launch-check-"));
    try{
        const home=join(dir,"home");
        const workspace=join(dir,"target project");
        const config=join(home,".config/owl");
        await mkdir(workspace,{recursive:true});
        await mkdir(config,{recursive:true});
        await writeFile(join(config,"env"),"DEEPSEEK_API_KEY=stub\nDEEPSEEK_MODEL=deepseek-flash\nDEEPSEEK_THINKING_MODE=disabled\n");
        const cwd=realpathSync(workspace);
        const cwdKey=createHash("sha256").update(cwd).digest("hex");
        const sessionDir=join(home,".owl/sessions",cwdKey);
        const id="00000000-0000-0000-0000-000000000001";
        await mkdir(sessionDir,{recursive:true});
        await writeFile(join(sessionDir,`${id}.jsonl`),JSON.stringify({
            type:"message",message:{role:"user",timestamp:1,content:[{type:"text",text:"synthetic history"}]},
        })+"\n");
        const env:NodeJS.ProcessEnv={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,".config")};
        delete env.DEEPSEEK_API_KEY;
        delete env.DEEPSEEK_MODEL;
        delete env.DEEPSEEK_THINKING_MODE;
        const result=spawnSync(launcher,["--no-tui","--session",id],{
            cwd,env,input:"/exit\n",encoding:"utf8",timeout:10000,
        });
        assert.equal(result.status,0,result.stderr);
        assert.ok(result.stderr.includes(join(sessionDir,`${id}.jsonl`)));
        assert.ok(result.stdout.includes("synthetic history"));
        await writeFile(join(config,"env"),"DEEPSEEK_API_KEY=stub\nDEEPSEEK_MODEL=invalid-model\nDEEPSEEK_THINKING_MODE=disabled\n");
        const overridden=spawnSync(launcher,["--no-tui","--session",id],{
            cwd,env:{...env,DEEPSEEK_MODEL:"deepseek-flash"},input:"/exit\n",encoding:"utf8",timeout:10000,
        });
        assert.equal(overridden.status,0,overridden.stderr);
    }finally{
        await rm(dir,{recursive:true,force:true});
    }
});

test("usage command reads a restored session in one-shot and text modes without a model call",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"owl-usage-cli-"));
    try{
        const session=join(dir,"session.jsonl");
        await writeFile(session,JSON.stringify({
            type:"usage",modelCallId:"call-1",usage:{
                inputTokens:40,cachedReadTokens:60,cachedWriteTokens:0,
                outputTokens:20,totalTokens:120,reasoningTokens:10,
            },
        })+"\n");
        const env={...process.env,DEEPSEEK_API_KEY:"stub",DEEPSEEK_MODEL:"deepseek-flash",DEEPSEEK_THINKING_MODE:"enabled"};
        const args=["--import","tsx",cli,"--no-tui","--session",session];
        for(const extra of [["/usage"],[]]){
            const result=spawnSync(process.execPath,[...args,...extra],{
                cwd:dirname(dirname(launcher)),env,input:extra.length?undefined:"/usage\n/exit\n",encoding:"utf8",timeout:10000,
            });
            assert.equal(result.status,0,result.stderr);
            assert.match(result.stdout,/缓存命中：60 tokens（60\.0%）/);
            assert.match(result.stdout,/累计输出：20 tokens/);
            assert.match(result.stdout,/累计总量：120 tokens/);
        }
        const invalid=spawnSync(process.execPath,[...args,"/usage detail"],{
            cwd:dirname(dirname(launcher)),env,encoding:"utf8",timeout:10000,
        });
        assert.equal(invalid.status,1);
        assert.match(invalid.stderr,/不接受参数/);
    }finally{
        await rm(dir,{recursive:true,force:true});
    }
});

test("text settings and startup flags configure the current process without a model call",()=>{
    const env={...process.env,DEEPSEEK_API_KEY:"stub",DEEPSEEK_MODEL:"deepseek-flash",DEEPSEEK_THINKING_MODE:"enabled"};
    const args=["--import","tsx",cli,"--no-tui"];
    const text=spawnSync(process.execPath,args,{
        cwd:dirname(dirname(launcher)),env,encoding:"utf8",timeout:10000,
        input:"/reasoning low\n/max-output 16384\n/max-calls 200\n/concurrency 2\n/parallel\n/settings\n/sequential\n/exit\n",
    });
    assert.equal(text.status,0,text.stderr);
    assert.match(text.stdout,/推理等级：low/);
    assert.match(text.stdout,/单次输出上限：16,384 tokens/);
    assert.match(text.stdout,/每次任务模型调用上限：200/);
    assert.match(text.stdout,/工具执行：parallel/);
    assert.match(text.stdout,/工具并发上限：2/);
    assert.match(text.stdout,/tool-mode = sequential/);

    const flags=spawnSync(process.execPath,[...args,"--reasoning","max","--max-output-tokens","65536",
        "--max-model-calls","300","--max-concurrent-tools","3","--parallel-tools","/settings"],{
        cwd:dirname(dirname(launcher)),env,encoding:"utf8",timeout:10000,
    });
    assert.equal(flags.status,0,flags.stderr);
    assert.match(flags.stdout,/推理等级：max/);
    assert.match(flags.stdout,/单次输出上限：65,536 tokens/);
    assert.match(flags.stdout,/上下文预留：65,536 tokens/);
    assert.match(flags.stdout,/每次任务模型调用上限：300/);
    assert.match(flags.stdout,/工具执行：parallel/);

    const invalid=spawnSync(process.execPath,[...args,"--reasoning","medium","/settings"],{
        cwd:dirname(dirname(launcher)),env,encoding:"utf8",timeout:10000,
    });
    assert.equal(invalid.status,1);
    assert.match(invalid.stderr,/不支持推理等级/);
});
