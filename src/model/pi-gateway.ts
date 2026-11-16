import type{Models}from "@earendil-works/pi-ai";
import type{ModelEvent, Request,Response,Usage}from "./types.js";
import {toPiOptions,toPiContext}from"./pi-request.js";
import {fromPiAssistantMessage}from "./pi-response.js";
import {ModelRequestError,type ModelGateway}from"./gateway.js";
import {readOpenAIStreamUsage} from "./pi-usage.js";
export class PiGateway implements ModelGateway{
    private readonly models:Models;
    constructor(models:Models){
        this.models=models;
    }

    async *stream(request:Request,signal:AbortSignal):AsyncIterable<ModelEvent> {
        signal.throwIfAborted();
        const model=this.models.getModel(request.model.providerId,request.model.modelId);
        if(model===undefined){
            throw new Error(`Model not found: ${request.model.providerId}/${request.model.modelId}`);
        }
        const options=toPiOptions(request,signal);
        const context=toPiContext(request);
        let observedUsage:Usage|null=null;
        const observesRawUsage=model.api==="openai-completions";
        if(observesRawUsage){
            options.onProviderStreamEvent=(event)=>{
                observedUsage=readOpenAIStreamUsage(event)??observedUsage;
            };
        }
        const piStream=this.models.streamSimple(model,context,options);
        try{
            for await(const event of piStream){
                switch(event.type){
                    case "text_delta":
                        yield {type:"text_delta",contentIndex:event.contentIndex,delta:event.delta};
                        break;
                    case "thinking_delta":
                        yield {type:"reasoning_delta",contentIndex:event.contentIndex,delta:event.delta};
                        break;
                    case "done":
                        yield {
                            type:"done",
                            response:fromPiAssistantMessage(event.message,observesRawUsage?observedUsage:undefined),
                        };
                        return;
                    case "error":
                        yield {
                            type:"done",
                            response:fromPiAssistantMessage(event.error,observesRawUsage?observedUsage:undefined),
                        };
                        return;
                    default:
                        break;
                }
            }
            throw new Error("Pi stream ended without a final response");
        }catch(error){
            throw new ModelRequestError(error,observedUsage);
        }
    }
    async complete(request:Request,signal:AbortSignal):Promise<Response>{
        for await(const event of this.stream(request,signal)){
            if(event.type==="done"){
                return event.response;
            }   
        }
        throw new Error("Model stream ended without a final response");
    }

}
