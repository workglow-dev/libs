/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import {
  createFetchUrlHttpError,
  FetchUrlErrorCode,
  HTTP_ERROR_DETAIL_MAX_CHARS,
  httpErrorDetailFromBody,
} from "@workglow/tasks";
import { describe, expect, test } from "vitest";

const YAHOO_RANGE_ERROR = JSON.stringify({
  chart: {
    result: null,
    error: {
      code: "Bad Request",
      description: "Date range exceeds maximum of 5 years for interval 1d",
    },
  },
});

describe("httpErrorDetailFromBody", () => {
  test("reads a top-level message", () => {
    expect(
      httpErrorDetailFromBody(JSON.stringify({ error: "Internal server error", message: "boom" }))
    ).toBe("boom");
  });

  test("reads a top-level error string", () => {
    expect(httpErrorDetailFromBody(JSON.stringify({ error: "invalid ticker" }))).toBe(
      "invalid ticker"
    );
  });

  test("prefers error_description over error", () => {
    expect(
      httpErrorDetailFromBody(
        JSON.stringify({ error: "invalid_grant", error_description: "token expired" })
      )
    ).toBe("token expired");
  });

  test("reads a nested error object", () => {
    expect(
      httpErrorDetailFromBody(
        JSON.stringify({ error: { code: "Bad Request", description: "bad range" } })
      )
    ).toBe("bad range");
    expect(
      httpErrorDetailFromBody(JSON.stringify({ error: { code: 400, message: "quota" } }))
    ).toBe("quota");
  });

  test("reads Yahoo's chart.error.description", () => {
    expect(httpErrorDetailFromBody(YAHOO_RANGE_ERROR)).toBe(
      "Date range exceeds maximum of 5 years for interval 1d"
    );
  });

  test("reads the first entry of an errors array", () => {
    expect(
      httpErrorDetailFromBody(JSON.stringify({ errors: [{ message: "first" }, { message: "b" }] }))
    ).toBe("first");
  });

  test("returns undefined for JSON with no error text", () => {
    expect(httpErrorDetailFromBody(JSON.stringify({ chart: { result: null } }))).toBeUndefined();
    expect(httpErrorDetailFromBody("{}")).toBeUndefined();
    expect(httpErrorDetailFromBody("[]")).toBeUndefined();
  });

  test("quotes a plain-text body, whitespace collapsed", () => {
    expect(httpErrorDetailFromBody("  Rate limit\n  exceeded  \n")).toBe("Rate limit exceeded");
  });

  test("quotes a truncated JSON body as text", () => {
    expect(httpErrorDetailFromBody('{"message":"cut off')).toBe('{"message":"cut off');
  });

  test("reads an HTML page's title, never its markup", () => {
    expect(
      httpErrorDetailFromBody(
        "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>x</h1></body></html>"
      )
    ).toBe("502 Bad Gateway");
    expect(httpErrorDetailFromBody("<html><body><h1>oops</h1></body></html>")).toBeUndefined();
  });

  test("reads an XML error document's Message", () => {
    expect(
      httpErrorDetailFromBody(
        '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>'
      )
    ).toBe("Access Denied");
  });

  test("skips binary bodies", () => {
    expect(httpErrorDetailFromBody("\u0000\u0001PNG\u0002")).toBeUndefined();
    expect(httpErrorDetailFromBody("abc�def")).toBeUndefined();
  });

  test("bounds the length", () => {
    const long = "x".repeat(5000);
    const fromText = httpErrorDetailFromBody(long)!;
    expect(fromText.length).toBe(HTTP_ERROR_DETAIL_MAX_CHARS);
    expect(fromText.endsWith("…")).toBe(true);
    const fromJson = httpErrorDetailFromBody(JSON.stringify({ message: long }))!;
    expect(fromJson.length).toBe(HTTP_ERROR_DETAIL_MAX_CHARS);
  });

  test("returns undefined for empty bodies", () => {
    expect(httpErrorDetailFromBody(undefined)).toBeUndefined();
    expect(httpErrorDetailFromBody("   ")).toBeUndefined();
    expect(httpErrorDetailFromBody('{"message":"  "}')).toBeUndefined();
  });
});

describe("createFetchUrlHttpError", () => {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/ABC";

  test("keeps the status line and appends the body's error text", () => {
    const error = createFetchUrlHttpError(url, 400, "Bad Request", undefined, YAHOO_RANGE_ERROR);
    expect(error.message).toBe(
      `Failed to fetch ${url}: 400 Bad Request: Date range exceeds maximum of 5 years for interval 1d`
    );
    expect(error.httpErrorMessage).toBe("Date range exceeds maximum of 5 years for interval 1d");
    expect(error.httpStatus).toBe(400);
    expect(error.httpStatusText).toBe("Bad Request");
  });

  test("keeps the error class and code", () => {
    const clientError = createFetchUrlHttpError(url, 400, "Bad Request", undefined, "nope");
    expect(clientError).toBeInstanceOf(PermanentJobError);
    expect(clientError.code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);

    const serverError = createFetchUrlHttpError(url, 503, "Service Unavailable", undefined, "busy");
    expect(serverError).toBeInstanceOf(RetryableJobError);
    expect(serverError.code).toBe(FetchUrlErrorCode.HTTP_SERVER_ERROR);
  });

  test("omits a body that only restates the status", () => {
    const error = createFetchUrlHttpError(url, 404, "Not Found", undefined, "Not Found");
    expect(error.message).toBe(`Failed to fetch ${url}: 404 Not Found`);
    expect(error.httpErrorMessage).toBeUndefined();
  });

  test("falls back to the status line without a usable body", () => {
    const error = createFetchUrlHttpError(url, 400, "Bad Request", undefined, undefined);
    expect(error.message).toBe(`Failed to fetch ${url}: 400 Bad Request`);
  });
});
