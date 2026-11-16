import {access} from "node:fs/promises";
import {constants} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute,join,resolve as nodeResolvePath} from "node:path";
import {fileURLToPath} from "node:url";

const UNICODE_SPACES=/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE="\u202F";

export interface PathInputOptions{
    trim?:boolean;
    expandTilde?:boolean;
    homeDir?:string;
    stripAtPrefix?:boolean;
    normalizeUnicodeSpaces?:boolean;
}

export function normalizeWindowsShellPath(filePath:string):string{
    if(!filePath.startsWith("/")||filePath.startsWith("//")||filePath.includes("\\")){
        return filePath;
    }
    const match=filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if(match===null){
        return filePath;
    }
    const suffix=match[2]?.replaceAll("/","\\");
    return `${match[1].toUpperCase()}:\\${suffix??""}`;
}

export function normalizePath(input:string,options:PathInputOptions={}):string{
    let normalized=options.trim?input.trim():input;
    if(options.normalizeUnicodeSpaces){
        normalized=normalized.replace(UNICODE_SPACES," ");
    }
    if(options.stripAtPrefix&&normalized.startsWith("@")){
        normalized=normalized.slice(1);
    }
    if(process.platform==="win32"){
        normalized=normalizeWindowsShellPath(normalized);
    }
    if(options.expandTilde??true){
        const home=options.homeDir??homedir();
        if(normalized==="~"){
            return home;
        }
        if(normalized.startsWith("~/")||(process.platform==="win32"&&normalized.startsWith("~\\"))){
            return join(home,normalized.slice(2));
        }
    }
    if(/^file:\/\//.test(normalized)){
        return fileURLToPath(normalized);
    }
    return normalized;
}

export function resolvePath(input:string,baseDir:string=process.cwd(),options:PathInputOptions={}):string{
    const normalized=normalizePath(input,options);
    const normalizedBaseDir=normalizePath(baseDir);
    return isAbsolute(normalized)
        ?nodeResolvePath(normalized)
        :nodeResolvePath(normalizedBaseDir,normalized);
}

export function expandPath(filePath:string):string{
    return normalizePath(filePath,{normalizeUnicodeSpaces:true,stripAtPrefix:true});
}

export function resolveToCwd(filePath:string,cwd:string):string{
    return resolvePath(filePath,cwd,{normalizeUnicodeSpaces:true,stripAtPrefix:true});
}

export async function resolveReadPathAsync(filePath:string,cwd:string):Promise<string>{
    const resolved=resolveToCwd(filePath,cwd);
    if(await pathExists(resolved)){
        return resolved;
    }
    const amPmVariant=resolved.replace(/ (AM|PM)\./gi,`${NARROW_NO_BREAK_SPACE}$1.`);
    if(amPmVariant!==resolved&&await pathExists(amPmVariant)){
        return amPmVariant;
    }
    const nfdVariant=resolved.normalize("NFD");
    if(nfdVariant!==resolved&&await pathExists(nfdVariant)){
        return nfdVariant;
    }
    const curlyVariant=resolved.replace(/'/g,"\u2019");
    if(curlyVariant!==resolved&&await pathExists(curlyVariant)){
        return curlyVariant;
    }
    const nfdCurlyVariant=curlyVariant.normalize("NFD");
    if(nfdCurlyVariant!==resolved&&await pathExists(nfdCurlyVariant)){
        return nfdCurlyVariant;
    }
    return resolved;
}

async function pathExists(filePath:string):Promise<boolean>{
    try{
        await access(filePath,constants.F_OK);
        return true;
    }catch{
        return false;
    }
}
