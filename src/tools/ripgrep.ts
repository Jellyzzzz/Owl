import {spawn} from "node:child_process";

const DEFAULT_TIMEOUT_MS=30_000;
const MAX_STDERR_BYTES=64*1024;
const RG_COMMAND_ENV="OWL_RG_PATH";

export interface RipgrepResult{
    readonly exitCode:number|null;
    readonly signalCode:NodeJS.Signals|null;
    readonly stderr:string;
    readonly timedOut:boolean;
    readonly stopped:boolean;
}

export class RipgrepUnavailableError extends Error{
    constructor(){
        super(
            "ripgrep (rg) is required for grep and find. "+
            "Install it with `brew install ripgrep` (macOS), `apt install ripgrep` (Debian/Ubuntu), "+
            "or see https://github.com/BurntSushi/ripgrep#installation.",
        );
        this.name="RipgrepUnavailableError";
    }
}

export interface RipgrepOptions{
    readonly args:readonly string[];
    readonly cwd:string;
    readonly signal:AbortSignal;
    /** Return false to stop ripgrep after the current stdout chunk. */
    readonly onStdout?: (chunk:string)=>boolean|void;
    readonly timeoutMs?:number;
}

function abortReason(signal:AbortSignal):Error{
    return signal.reason instanceof Error?signal.reason:new Error("Operation aborted");
}

function command():string{
    const configured=process.env[RG_COMMAND_ENV]?.trim();
    return configured&&configured.length>0?configured:"rg";
}

function timeoutMessage(timeoutMs:number):string{
    return `Search timed out after ${Math.ceil(timeoutMs/1000)} seconds`;
}

/**
 * Run ripgrep without a shell. stdout is streamed to the caller, and the
 * caller can stop the process early by returning false from onStdout.
 */
export function runRipgrep(options:RipgrepOptions):Promise<RipgrepResult>{
    const {args,cwd,signal,onStdout,timeoutMs=DEFAULT_TIMEOUT_MS}=options;
    signal.throwIfAborted();

    return new Promise<RipgrepResult>((resolve,reject)=>{
        let settled=false;
        let stopped=false;
        let timedOut=false;
        let stderr="";
        let stderrBytes=0;
        let timer:NodeJS.Timeout|undefined;

        const child=spawn(command(),[...args],{
            cwd:cwd,
            env:process.env,
            stdio:["ignore","pipe","pipe"],
        });

        const cleanup=():void=>{
            if(timer!==undefined){
                clearTimeout(timer);
                timer=undefined;
            }
            signal.removeEventListener("abort",handleAbort);
        };
        const finish=(error?:Error):void=>{
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            if(error!==undefined){
                reject(error);
            }
        };
        const stop=():void=>{
            if(!child.killed){
                child.kill("SIGKILL");
            }
        };
        const handleAbort=():void=>{
            stop();
            finish(abortReason(signal));
        };

        child.once("error",(error:NodeJS.ErrnoException)=>{
            stop();
            if(error.code==="ENOENT"){
                finish(new RipgrepUnavailableError());
            }else{
                finish(new Error(`Failed to start ripgrep: ${error.message}`));
            }
        });

        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data",(chunk:string)=>{
            if(settled||stopped){
                return;
            }
            try{
                if(onStdout!==undefined&&onStdout(chunk)===false){
                    stopped=true;
                    stop();
                }
            }catch(error:unknown){
                stop();
                finish(error instanceof Error?error:new Error(String(error)));
            }
        });

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data",(chunk:string)=>{
            if(stderrBytes>=MAX_STDERR_BYTES){
                return;
            }
            const remaining=MAX_STDERR_BYTES-stderrBytes;
            const text=chunk.length>remaining?chunk.slice(0,remaining):chunk;
            stderr+=text;
            stderrBytes+=Buffer.byteLength(text,"utf-8");
            if(stderrBytes>=MAX_STDERR_BYTES){
                stderr+="\n[stderr truncated]";
            }
        });

        child.once("close",(exitCode,signalCode)=>{
            if(settled){
                return;
            }
            if(timedOut){
                finish(new Error(timeoutMessage(timeoutMs)));
                return;
            }
            settled=true;
            cleanup();
            resolve({
                exitCode:exitCode,
                signalCode:signalCode,
                stderr:stderr.trim(),
                timedOut:false,
                stopped:stopped,
            });
        });

        if(signal.aborted){
            handleAbort();
            return;
        }
        signal.addEventListener("abort",handleAbort,{once:true});
        timer=setTimeout(()=>{
            timedOut=true;
            stop();
            finish(new Error(timeoutMessage(timeoutMs)));
        },timeoutMs);
    });
}
