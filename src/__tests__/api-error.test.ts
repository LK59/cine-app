import { describe, it, expect } from "vitest";
import { classifyError } from "@/lib/api-error";

describe("classifyError", () => {
  it("classifies the 'not configured' phrasing used by dashboard probes as missing_api_key", () => {
    const err = new Error("Non configuré — définis RADARR_API_KEY dans .env (voir README > Deployment)");
    const result = classifyError(err);
    expect(result.kind).toBe("missing_api_key");
    expect(result.detail).toBe(err.message);
  });

  it("classifies a 401 HttpError as unauthorized, not missing_api_key", async () => {
    const { HttpError } = await import("@/lib/http");
    const result = classifyError(new HttpError("401 Unauthorized", 401));
    expect(result.kind).toBe("unauthorized");
  });

  it("classifies a connection-refused error as unreachable", () => {
    const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:7878"));
    expect(result.kind).toBe("unreachable");
  });

  it("classifies an AbortError as timeout", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifyError(err).kind).toBe("timeout");
  });
});
