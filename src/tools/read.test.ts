import {afterEach,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type{ToolContext,ToolResult} from "./types.js";
import {ReadTool} from "./read.js";
import {DEFAULT_MAX_BYTES,DEFAULT_MAX_LINES,formatSize} from "./truncate.js";

let testDir:string;

beforeEach(async()=>{
    testDir=await mkdtemp(join(tmpdir(),"owl-read-"));
});
afterEach(async()=>{
    await rm(testDir,{recursive:true,force:true});
});

function createContext(cwd=testDir,signal=new AbortController().signal):ToolContext{
    return {callId:"call-1",cwd:cwd,signal:signal};
}
async function read(args:unknown,context=createContext()):Promise<ToolResult>{
    return ReadTool.execute(args,context);
}
function text(result:ToolResult):string{
    return result.content
        .filter(block=>block.type==="text")
        .map(block=>block.text)
        .join("\n");
}

test("read: returns file contents that fit within the limits",async()=>{
    const file=join(testDir,"test.txt");
    const content="Hello, world!\nLine 2\nLine 3";
    await writeFile(file,content);

    const result=await read({path:file});
    assert.equal(text(result),content);
    assert.equal(result.details,undefined);
    assert.ok(!text(result).includes("Use offset="));
});

test("read: resolves relative paths against the tool context cwd",async()=>{
    await writeFile(join(testDir,"hello world.txt"),"relative content");

    const result=await read({path:"@hello\u00A0world.txt"});
    assert.equal(text(result),"relative content");
});

test("read: missing files fail with the filesystem error",async()=>{
    await assert.rejects(read({path:"missing.txt"}),/ENOENT|not found/i);
});

test("read: preserves a trailing newline",async()=>{
    const file=join(testDir,"trailing.txt");
    await writeFile(file,"line 1\nline 2\n");
    assert.equal(text(await read({path:file})),"line 1\nline 2\n");
});

test("read: empty files return empty text",async()=>{
    const file=join(testDir,"empty.txt");
    await writeFile(file,"");
    const result=await read({path:file});
    assert.equal(text(result),"");
    assert.equal(result.details,undefined);
});

test("read: truncates files exceeding the line limit",async()=>{
    const file=join(testDir,"large.txt");
    const totalLines=DEFAULT_MAX_LINES+500;
    const lines=Array.from({length:totalLines},(_,index)=>`Line ${index+1}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file}));
    assert.ok(output.includes("Line 1"));
    assert.ok(output.includes(`Line ${DEFAULT_MAX_LINES}`));
    assert.ok(!output.includes(`Line ${DEFAULT_MAX_LINES+1}`));
    assert.ok(output.includes(`[Showing lines 1-${DEFAULT_MAX_LINES} of ${totalLines}. Use offset=${DEFAULT_MAX_LINES+1} to continue.]`));
});

test("read: truncates files exceeding the byte limit",async()=>{
    const file=join(testDir,"large-bytes.txt");
    const lines=Array.from({length:500},(_,index)=>`Line ${index+1}: ${"x".repeat(200)}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file}));
    assert.ok(output.includes("Line 1:"));
    const size=formatSize(DEFAULT_MAX_BYTES).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    assert.match(output,new RegExp(`\\[Showing lines 1-\\d+ of 500 \\(${size} limit\\)\\. Use offset=\\d+ to continue\\.\\]`));
});

test("read: offset starts reading at a 1-indexed line",async()=>{
    const file=join(testDir,"offset.txt");
    const lines=Array.from({length:100},(_,index)=>`Line ${index+1}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file,offset:51}));
    assert.ok(!output.includes("Line 50"));
    assert.ok(output.includes("Line 51"));
    assert.ok(output.includes("Line 100"));
    assert.ok(!output.includes("Use offset="));
});

test("read: limit reports the remaining lines",async()=>{
    const file=join(testDir,"limit.txt");
    const lines=Array.from({length:100},(_,index)=>`Line ${index+1}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file,limit:10}));
    assert.ok(output.includes("Line 1"));
    assert.ok(output.includes("Line 10"));
    assert.ok(!output.includes("Line 11"));
    assert.ok(output.includes("[90 more lines in file. Use offset=11 to continue.]"));
});

test("read: offset and limit work together",async()=>{
    const file=join(testDir,"offset-limit.txt");
    const lines=Array.from({length:100},(_,index)=>`Line ${index+1}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file,offset:41,limit:20}));
    assert.ok(!output.includes("Line 40"));
    assert.ok(output.includes("Line 41"));
    assert.ok(output.includes("Line 60"));
    assert.ok(!output.includes("Line 61"));
    assert.ok(output.includes("[40 more lines in file. Use offset=61 to continue.]"));
});

test("read: offset beyond the end of the file is an error",async()=>{
    const file=join(testDir,"short.txt");
    await writeFile(file,"Line 1\nLine 2\nLine 3");

    await assert.rejects(
        read({path:file,offset:100}),
        /Offset 100 is beyond end of file \(3 lines total\)/,
    );
});

test("read: returns truncation details",async()=>{
    const file=join(testDir,"details.txt");
    const lines=Array.from({length:DEFAULT_MAX_LINES+500},(_,index)=>`Line ${index+1}`);
    await writeFile(file,lines.join("\n"));

    const details=await read({path:file});
    const truncation=(details.details as {truncation?:Record<string,unknown>}).truncation;
    assert.ok(truncation);
    assert.equal(truncation.truncated,true);
    assert.equal(truncation.truncatedBy,"lines");
    assert.equal(truncation.totalLines,DEFAULT_MAX_LINES+500);
    assert.equal(truncation.outputLines,DEFAULT_MAX_LINES);
});

test("read: points at bash when the first line exceeds the byte limit",async()=>{
    const file=join(testDir,"one-long-line.txt");
    const lineBytes=Math.max(60*1024,DEFAULT_MAX_BYTES+1024);
    await writeFile(file,"x".repeat(lineBytes));

    const result=await read({path:file});
    const output=text(result);
    assert.ok(output.startsWith(`[Line 1 is ${formatSize(lineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '1p'`));
    const truncation=(result.details as {truncation?:Record<string,unknown>}).truncation;
    assert.equal(truncation?.firstLineExceedsLimit,true);
});

test("read: detects images from file magic instead of the extension",async()=>{
    const png=Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
        "base64",
    );
    const file=join(testDir,"image.txt");
    await writeFile(file,png);

    const result=await read({path:file});
    assert.equal(result.content[0]?.type,"text");
    assert.ok(text(result).includes("Read image file [image/png]"));
    const image=result.content.find(block=>block.type==="image");
    assert.ok(image);
    assert.equal(image.mimeType,"image/png");
    assert.deepEqual(Buffer.from(image.data,"base64"),png);
});

test("read: treats non-image data in an image-named file as text",async()=>{
    const file=join(testDir,"not-an-image.png");
    await writeFile(file,"definitely not a png");

    const result=await read({path:file});
    assert.equal(text(result),"definitely not a png");
    assert.ok(result.content.every(block=>block.type==="text"));
});

test("read: omits BMP images that cannot be converted inline",async()=>{
    const bmp=Buffer.alloc(58);
    bmp.write("BM",0,"ascii");
    bmp.writeUInt32LE(bmp.length,2);
    bmp.writeUInt32LE(54,10);
    bmp.writeUInt32LE(40,14);
    bmp.writeInt32LE(1,18);
    bmp.writeInt32LE(1,22);
    bmp.writeUInt16LE(1,26);
    bmp.writeUInt16LE(24,28);
    bmp[56]=0xff;
    const file=join(testDir,"image.bmp");
    await writeFile(file,bmp);

    const result=await read({path:file});
    assert.ok(text(result).includes("Read image file [image/bmp]"));
    assert.ok(text(result).includes("could not be converted to a supported inline image format"));
    assert.ok(result.content.every(block=>block.type==="text"));
});

test("read: an explicit limit is honored beyond the default line cap",async()=>{
    const file=join(testDir,"many-short-lines.txt");
    const totalLines=DEFAULT_MAX_LINES+800;
    const lines=Array.from({length:totalLines},(_,index)=>`${index+1}`);
    await writeFile(file,lines.join("\n"));

    const output=text(await read({path:file,limit:totalLines}));
    assert.equal(output,lines.join("\n"));
    assert.ok(!output.includes("Use offset="));
    assert.ok(!output.includes("limit)"));
});

test("read: rejects fractional and out-of-range parameters",async()=>{
    const file=join(testDir,"params.txt");
    await writeFile(file,"Line 1\nLine 2");

    await assert.rejects(read({path:file,offset:0}),/offset must be an integer/);
    await assert.rejects(read({path:file,offset:1.5}),/offset must be an integer/);
    await assert.rejects(read({path:file,limit:0}),/limit must be an integer/);
    await assert.rejects(read({path:file,limit:1.5}),/limit must be an integer/);
});

test("read: cancellation before execution propagates the abort reason",async()=>{
    const controller=new AbortController();
    const reason=new Error("User cancelled");
    controller.abort(reason);
    await assert.rejects(
        read({path:"anything.txt"},createContext(testDir,controller.signal)),
        error=>error===reason,
    );
});

test("read: exposes a strict path schema",()=>{
    const parameters=JSON.parse(ReadTool.definition.parametersJson) as {
        properties?:Record<string,{type?:string;minimum?:number;maximum?:number}>;
        required?:string[];
    };
    assert.equal(ReadTool.definition.name,"read");
    assert.deepEqual(Object.keys(parameters.properties??{}),["path","offset","limit"]);
    assert.deepEqual(parameters.required,["path"]);
    assert.equal(parameters.properties?.offset?.type,"integer");
    assert.equal(parameters.properties?.offset?.minimum,1);
    assert.equal(parameters.properties?.limit?.type,"integer");
    assert.equal(parameters.properties?.limit?.minimum,1);
});
