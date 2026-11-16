import {chmod,mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const FAKE_RG_SCRIPT=`#!/usr/bin/env node
const fs=require("node:fs");
const files=JSON.parse(process.env.OWL_FAKE_RG_FILES||"[]");
const events=JSON.parse(process.env.OWL_FAKE_RG_EVENTS||"[]");
const exitCode=Number(process.env.OWL_FAKE_RG_EXIT||"0");
const stderr=process.env.OWL_FAKE_RG_STDERR||"";
const hang=process.env.OWL_FAKE_RG_HANG==="1";
const argsFile=process.env.OWL_FAKE_RG_ARGS_FILE||"";
const args=process.argv.slice(2);
if(argsFile.length>0){
    fs.writeFileSync(argsFile,JSON.stringify(args));
}
if(args.includes("--files")){
    const sorted=[...files].sort((left,right)=>String(left).localeCompare(String(right)));
    for(const file of sorted){
        process.stdout.write(String(file)+"\\0");
    }
}else{
    for(const event of events){
        process.stdout.write(JSON.stringify(event)+"\\n");
    }
}
if(stderr.length>0){
    process.stderr.write(stderr);
}
process.exitCode=exitCode;
if(hang){
    setInterval(()=>{},1000);
}
`;

export interface FakeRipgrepOutput{
    readonly files?:readonly string[];
    readonly events?:readonly unknown[];
    readonly exitCode?:number;
    readonly stderr?:string;
    readonly hang?:boolean;
    readonly argsFile?:string;
}

export interface FakeRipgrep{
    readonly path:string;
    readonly dir:string;
    readonly setOutput:(output:FakeRipgrepOutput)=>void;
    readonly restore:()=>Promise<void>;
}

export async function installFakeRipgrep():Promise<FakeRipgrep>{
    const dir=await mkdtemp(join(tmpdir(),"owl-fake-rg-"));
    const path=join(dir,"rg");
    await writeFile(path,FAKE_RG_SCRIPT);
    await chmod(path,0o755);
    const previous=process.env.OWL_RG_PATH;
    process.env.OWL_RG_PATH=path;
    return {
        path:path,
        dir:dir,
        setOutput(output:FakeRipgrepOutput):void{
            process.env.OWL_FAKE_RG_FILES=JSON.stringify(output.files??[]);
            process.env.OWL_FAKE_RG_EVENTS=JSON.stringify(output.events??[]);
            process.env.OWL_FAKE_RG_EXIT=String(output.exitCode??0);
            process.env.OWL_FAKE_RG_STDERR=output.stderr??"";
            process.env.OWL_FAKE_RG_HANG=output.hang?"1":"0";
            process.env.OWL_FAKE_RG_ARGS_FILE=output.argsFile??"";
        },
        async restore():Promise<void>{
            if(previous===undefined){
                delete process.env.OWL_RG_PATH;
            }else{
                process.env.OWL_RG_PATH=previous;
            }
            for(const key of ["OWL_FAKE_RG_FILES","OWL_FAKE_RG_EVENTS","OWL_FAKE_RG_EXIT","OWL_FAKE_RG_STDERR","OWL_FAKE_RG_HANG","OWL_FAKE_RG_ARGS_FILE"]){
                delete process.env[key];
            }
            await rm(dir,{recursive:true,force:true});
        },
    };
}

export function ripgrepEvent(
    type:"match"|"context",
    filePath:string,
    lineNumber:number,
    text:string,
):unknown{
    return {
        type:type,
        data:{
            path:{text:filePath},
            lines:{text:`${text}\n`},
            line_number:lineNumber,
        },
    };
}
