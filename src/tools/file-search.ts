import {stat} from "node:fs/promises";
import {basename,matchesGlob,relative,sep} from "node:path";

export interface SearchPathInfo{
    readonly isDirectory:boolean;
}

export async function inspectSearchPath(searchPath:string):Promise<SearchPathInfo>{
    let info;
    try{
        info=await stat(searchPath);
    }catch(error:unknown){
        const code=(error as NodeJS.ErrnoException).code;
        if(code==="ENOENT"||code==="ENOTDIR"){
            throw new Error(`Path not found: ${searchPath}`);
        }
        throw new Error(`Cannot access path ${searchPath}: ${error instanceof Error?error.message:String(error)}`);
    }
    if(!info.isDirectory()&&!info.isFile()){
        throw new Error(`Path is not a file or directory: ${searchPath}`);
    }
    return {isDirectory:info.isDirectory()};
}

/**
 * Match a path with glob semantics similar to ripgrep's --glob. A pattern
 * without a slash matches the basename at any depth; a path-containing
 * pattern is matched relative to the search root.
 *
 * Node's matchesGlob treats dotfiles specially, while ripgrep searches hidden
 * files when --hidden is set. The fallback strips dots only from directory
 * segments so `**\/*.ts` still matches `.hidden/hidden.ts` without making
 * `*.ts` match an unrelated file named `ts`.
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
    if(matchesGlob(normalizedPath,normalizedPattern)){
        return true;
    }
    return matchesGlob(stripHiddenDirectories(normalizedPath),normalizedPattern);
}

function stripHiddenDirectories(filePath:string):string{
    const segments=filePath.split("/");
    return segments
        .map((segment,index)=>{
            const isDirectory=index<segments.length-1;
            return isDirectory&&segment.startsWith(".")?segment.slice(1):segment;
        })
        .join("/");
}

export function relativeSearchPath(root:string,filePath:string,isDirectory:boolean):string{
    if(!isDirectory){
        return basename(filePath);
    }
    const relativePath=relative(root,filePath);
    return relativePath.length===0?basename(filePath):relativePath.split(sep).join("/");
}
