import { describe, expect, it } from "vitest";
import {
  buildMcpTestRequest,
  buildSavePayload,
} from "../../src/renderer/components/mcp-test-request";
import { DEFAULT_SETTINGS, type AppSettings } from "../../src/shared/types/settings";

function build(
  fields: {
    moocsUsername?: string;
    moocsPassword?: string;
    hasMoocsCredentials?: boolean;
  },
  edited: Array<keyof AppSettings> = []
) {
  return buildMcpTestRequest(
    { ...DEFAULT_SETTINGS, hasApiKey: false, hasMoocsCredentials: false, ...fields },
    new Set(edited)
  );
}

describe("buildSavePayload", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    apiKey: "sk-new",
    moocsUsername: "user",
    moocsPassword: "rejected",
    hasApiKey: false,
    hasMoocsCredentials: true,
  };
  const edited = new Set<keyof AppSettings>(["apiKey", "moocsUsername", "moocsPassword"]);

  it("sends every edited field when no test has failed", () => {
    expect(buildSavePayload(settings, edited, false)).toEqual({
      apiKey: "sk-new",
      moocsUsername: "user",
      moocsPassword: "rejected",
    });
  });

  it("does not send credentials rejected by the connection test", () => {
    expect(buildSavePayload(settings, edited, true)).toEqual({ apiKey: "sk-new" });
  });

  it("does not overwrite the saved password with a blank field", () => {
    expect(
      buildSavePayload(
        { ...settings, moocsPassword: "   " },
        new Set<keyof AppSettings>(["moocsPassword"]),
        false
      )
    ).toEqual({});
  });
});

describe("buildMcpTestRequest", () => {
  it("cannot test until both the username and password are available", () => {
    expect(build({}).canTest).toBe(false);
    expect(build({ moocsUsername: "user" }, ["moocsUsername"]).canTest).toBe(false);
    expect(build({ moocsPassword: "pass" }, ["moocsPassword"]).canTest).toBe(false);
    expect(
      build({ moocsUsername: "   ", moocsPassword: "pass" }, ["moocsUsername", "moocsPassword"])
        .canTest
    ).toBe(false);
  });

  it("sends both typed values", () => {
    expect(
      build({ moocsUsername: " user ", moocsPassword: "pass" }, ["moocsUsername", "moocsPassword"])
    ).toEqual({
      canTest: true,
      input: { moocsUsername: "user", moocsPassword: "pass" },
    });
  });

  it("tests saved credentials with an empty input", () => {
    expect(build({ moocsUsername: "user", hasMoocsCredentials: true })).toEqual({
      canTest: true,
      input: {},
    });
  });

  it("sends only the changed value when the other one is saved", () => {
    expect(
      build({ moocsUsername: "user", moocsPassword: "new", hasMoocsCredentials: true }, [
        "moocsPassword",
      ])
    ).toEqual({ canTest: true, input: { moocsPassword: "new" } });
  });

  it("treats a cleared password field as unchanged", () => {
    expect(
      build({ moocsUsername: "user", moocsPassword: "", hasMoocsCredentials: true }, [
        "moocsPassword",
      ])
    ).toEqual({ canTest: true, input: {} });
    expect(
      build({ moocsUsername: "user", moocsPassword: "   ", hasMoocsCredentials: false }, [
        "moocsPassword",
      ]).canTest
    ).toBe(false);
  });

  it("does not trim a typed password", () => {
    expect(
      build({ moocsUsername: "user", moocsPassword: " p w " }, ["moocsPassword"]).input
    ).toEqual({ moocsPassword: " p w " });
  });
});
