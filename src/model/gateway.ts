import type{Request,Response,ModelEvent,Usage} from "./types.js";
export interface ModelGateway{
    complete(request:Request,signal:AbortSignal):Promise<Response>;
    stream(request:Request,signal:AbortSignal):AsyncIterable<ModelEvent>;
}

/** A dispatched request ended without a response; its usage may still be known. */
export class ModelRequestError extends Error{
    readonly usage:Usage|null;

    constructor(cause:unknown,usage:Usage|null){
        super(cause instanceof Error?cause.message:String(cause),{cause});
        this.name=cause instanceof Error?cause.name:"Error";
        this.usage=usage;
    }
}
