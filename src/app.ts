import express, { type Request, type Response, type NextFunction } from "express";
import { RPC_VERSION } from "./constants";
import { RPC_ERROR_CODES } from "./errors";
import { Ledger } from "./ledger";
import { handleRpcRequest } from "./rpc";

export function createApp(ledger = new Ledger()) {
  const app = express();

  app.use(express.json());

  app.post("/", async (req: Request, res: Response) => {
    const response = await handleRpcRequest(req.body, ledger);
    res.json(response);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(200).json({
        jsonrpc: RPC_VERSION,
        id: null,
        error: {
          code: RPC_ERROR_CODES.INVALID_REQUEST,
          message: "Invalid request",
        },
      });
      return;
    }

    res.status(200).json({
      jsonrpc: RPC_VERSION,
      id: null,
      error: {
        code: RPC_ERROR_CODES.INVALID_REQUEST,
        message: "Invalid request",
      },
    });
  });

  return { app, ledger };
}
