import { describe, expect, it } from "vitest";
import { loadMailer, mailerProblem, readSmtpUrl } from "../src/mailer.js";

describe("SMTP_URL", () => {
  it("accepts an app password shown with spaces", () => {
    expect(readSmtpUrl("smtps://takwi%40example.com:abcd efgh ijkl mnop@smtp.gmail.com:465")).toEqual({
      url: "smtps://takwi%40example.com:abcdefghijklmnop@smtp.gmail.com:465",
      host: "smtp.gmail.com",
    });
  });

  it("never stops the server over a bad value, and never repeats the password", () => {
    for (const bad of ["not a url at all", "https://user:secret-pass@smtp.gmail.com", "smtps://smtp.gmail.com:465", "smtps://takwi@example.com:secret-pass@"]) {
      expect(loadMailer({ SMTP_URL: bad })).toBeNull();
      expect(mailerProblem()).toBeTruthy();
      expect(mailerProblem()).not.toContain("secret-pass");
    }
    expect(loadMailer({})).toBeNull();
    expect(mailerProblem()).toBeUndefined();
  });
});
