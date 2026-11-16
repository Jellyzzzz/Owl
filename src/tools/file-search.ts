import {execFile} from "node:child_process";
import {readdir,realpath,stat} from "node:fs/promises";
import {basename,join,matchesGlob,relative,sep} from "node:path";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);
const GIT_MAX_BUFFER=64*1024*1024;
const SKIPPED_DIRECTORIES=new Set([".git","node_modules"]);

export async function listFiles(root:string,signal:AbortSignal):Promise<string[]>{
    signal.throwIfAborted();
    const rootStat=await stat(root);
    if(rootStat.isFile()){
        return [root];
    }
    if(!rootStat.isDirectory()){
        throw new Error(`Path is not a file or directory: ${root}`);
    }
    const gitFiles=await listGitFiles(root,signal);
    if(gitFiles!==undefined){
        return gitFiles;
    }
    return walkFiles(root,signal);
}

/**
 * Match a path the way Pi's find tool does: a pattern without a slash matches
 * the basename at any depth, while a path-containing pattern is matched
 * relative to the search root.
 */
export function matchesPathPattern(filePath:string,pattern:string):boolean{
    const normalizedPath=filePath.split(sep).join("/");
    let normalizedPattern=pattern.replaceAll("\\","/");
    if(normalizedPattern.startsWith("./")){
        normalizedPattern=normalizedPattern.slice(2);
    }
    if(!normalizedPattern.includes("/")){
        const name=basename(normalizedPath);
        return matchesGlob(name,normalizedPattern)||
            (name.startsWith(".")&&matchesGlob(name.slice(1),normalizedPattern));
    }
    if(!normalizedPattern.startsWith("/")&&!normalizedPattern.startsWith("**/")&&normalizedPattern!=="**"){
        normalizedPattern=`**/${normalizedPattern}`;
    }
    return matchesGlob(normalizedPath,normalizedPattern);
}

async function listGitFiles(root:string,signal:AbortSignal):Promise<string[]|undefined>{
    let repoRoot:string;
    try{
        const {stdout}=await execFileAsync(
            "git",
            ["-C",root,"rev-parse","--show-toplevel"],
            {signal:signal,maxBuffer:GIT_MAX_BUFFER},
        );
        repoRoot=stdout.trim();
    }catch{
        if(signal.aborted){
            signal.throwIfAborted();
        }
        return undefined;
    }
    if(repoRoot.length===0){
        return undefined;
    }
    try{
        const {stdout}=await execFileAsync(
            "git",
            ["-C",repoRoot,"ls-files","--cached","--others","--exclude-standard","-z"],
            {signal:signal,maxBuffer:GIT_MAX_BUFFER},
        );
        const realRoot=await realpath(root);
        const realRepoRoot=await realpath(repoRoot);
        const rootRelative=relative(realRepoRoot,realRoot).split(sep).join("/");
        const files:string[]=[];
        for(const relativePath of stdout.split("\0")){
            if(relativePath.length===0){
                continue;
            }
            const normalizedPath=relativePath.replaceAll("\\","/");
            if(
                rootRelative.length>0&&
                normalizedPath!==rootRelative&&
                !normalizedPath.startsWith(`${rootRelative}/`)
            ){
                continue;
            }
            const withinRoot=rootRelative.length===0
                ?normalizedPath
                :normalizedPath.slice(rootRelative.length+1);
            files.push(join(root,withinRoot));
        }
        return files;
    }catch{
        if(signal.aborted){
            signal.throwIfAborted();
        }
        return undefined;
    }
}

async function walkFiles(directory:string,signal:AbortSignal,output:string[]=[]):Promise<string[]>{
    signal.throwIfAborted();
    let entries;
    try{
        entries=await readdir(directory,{withFileTypes:true});
    }catch{
        return output;
    }
    entries.sort((left,right)=>left.name.localeCompare(right.name));
    for(const entry of entries){
        signal.throwIfAborted();
        if(SKIPPED_DIRECTORIES.has(entry.name)){
            continue;
        }
        const absolutePath=join(directory,entry.name);
        if(entry.isDirectory()){
            await walkFiles(absolutePath,signal,output);
        }else if(entry.isFile()){
            output.push(absolutePath);
        }
    }
    return output;
}

export function relativeSearchPath(root:string,filePath:string,isDirectory:boolean):string{
    if(!isDirectory){
        return basename(filePath);
    }
    const relativePath=relative(root,filePath);
    return relativePath.length===0?basename(filePath):relativePath.split(sep).join("/");
}
