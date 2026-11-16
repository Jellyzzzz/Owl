import {test} from "node:test";
import assert from "node:assert/strict";
import {formatSize,truncateHead,truncateLine,truncateTail} from "./truncate.js";

test("truncate: head keeps content that fits within both limits",()=>{
    const result=truncateHead("alpha\nbeta\ngamma");
    assert.equal(result.truncated,false);
    assert.equal(result.truncatedBy,null);
    assert.equal(result.content,"alpha\nbeta\ngamma");
    assert.equal(result.totalLines,3);
    assert.equal(result.outputLines,3);
    assert.equal(result.firstLineExceedsLimit,false);
});

test("truncate: trailing newline does not count as an extra line",()=>{
    const result=truncateHead("alpha\nbeta\n");
    assert.equal(result.truncated,false);
    assert.equal(result.totalLines,2);
    assert.equal(result.content,"alpha\nbeta\n");
});

test("truncate: head stops at the line limit without a partial line",()=>{
    const result=truncateHead("a\nb\nc",{maxLines:2});
    assert.equal(result.truncated,true);
    assert.equal(result.truncatedBy,"lines");
    assert.equal(result.content,"a\nb");
    assert.equal(result.totalLines,3);
    assert.equal(result.outputLines,2);
});

test("truncate: head stops at the byte limit",()=>{
    const result=truncateHead("12345\n67890",{maxBytes:7});
    assert.equal(result.truncated,true);
    assert.equal(result.truncatedBy,"bytes");
    assert.equal(result.content,"12345");
    assert.equal(result.outputBytes,5);
    assert.equal(result.outputLines,1);
});

test("truncate: head reports a first line that exceeds the byte limit",()=>{
    const result=truncateHead("abcdef\nx",{maxBytes:4});
    assert.equal(result.truncated,true);
    assert.equal(result.truncatedBy,"bytes");
    assert.equal(result.content,"");
    assert.equal(result.firstLineExceedsLimit,true);
    assert.equal(result.outputLines,0);
    assert.equal(result.totalLines,2);
});

test("truncate: tail keeps the last lines",()=>{
    const result=truncateTail("a\nb\nc",{maxLines:2});
    assert.equal(result.truncated,true);
    assert.equal(result.truncatedBy,"lines");
    assert.equal(result.content,"b\nc");
    assert.equal(result.outputLines,2);
});

test("truncate: formatSize uses human-readable units",()=>{
    assert.equal(formatSize(0),"0B");
    assert.equal(formatSize(1023),"1023B");
    assert.equal(formatSize(1024),"1.0KB");
    assert.equal(formatSize(50*1024),"50.0KB");
    assert.equal(formatSize(1024*1024),"1.0MB");
});

test("truncate: lines over the grep limit are marked",()=>{
    assert.deepEqual(truncateLine("short"),{text:"short",wasTruncated:false});
    const truncated=truncateLine("x".repeat(501));
    assert.equal(truncated.wasTruncated,true);
    assert.equal(truncated.text.length,500+"... [truncated]".length);
    assert.ok(truncated.text.endsWith("... [truncated]"));
});
