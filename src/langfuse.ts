import { LangfuseClient } from "@langfuse/client";
import { assertLangfuseEnv } from "./env.js";

assertLangfuseEnv();

/**
 * The Langfuse client.
 *
 * Reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from the
 * environment. Point LANGFUSE_BASE_URL at your own deployment to run this whole
 * reference app against self-hosted Langfuse with no code change.
 */
export const langfuse = new LangfuseClient();
