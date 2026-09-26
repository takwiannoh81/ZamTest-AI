/**
 * Signing in to a website with a saved user name and password (a credential
 * asset), on a sign-in form the steps have not seen: the password field is the
 * visible `input[type=password]`, and the user name is the text or email field
 * of the same form. Used by "Generate tests with AI" to sign in before exploring,
 * and at the start of each test it writes. The password is read from the asset
 * when the steps run; it is never in the steps themselves.
 */
import type { Step, VariableDef } from "./schema.js";
import { newStepId } from "./schema.js";

/** The user name (or email) field of the form that has the password field. */
export const SIGN_IN_USER_SELECTOR =
  'form:has(input[type="password"]) input:is([type="email"], [type="text"], [type="tel"], :not([type])):visible, input[autocomplete="username"]:visible, input[type="email"]:visible >> nth=0';
export const SIGN_IN_PASSWORD_SELECTOR = 'input[type="password"]:visible >> nth=0';

/** The variable the credential is read into. */
export const SIGN_IN_VARIABLE = "signIn";
export const SIGN_IN_VARIABLES: VariableDef[] = [{ name: SIGN_IN_VARIABLE, type: "object", direction: "local", description: "The saved sign-in (user name and password)" }];

export interface SignInOptions {
  /** The credential asset: { username, password }. */
  asset: string;
  /** Where the sign-in form is. */
  signInUrl: string;
  /** Where to go once signed in (unset: stay where the site leads). */
  thenUrl?: string;
}

export function signInSteps({ asset, signInUrl, thenUrl }: SignInOptions): Step[] {
  const v = SIGN_IN_VARIABLE;
  const steps: Step[] = [
    { id: newStepId(), type: "core.getAsset", label: "Read the sign-in", props: { name: asset, output: v } },
    { id: newStepId(), type: "browser.open", label: "Open the sign-in page", props: { url: signInUrl } },
    {
      id: newStepId(),
      type: "browser.type",
      label: "Type the user name",
      props: { selector: SIGN_IN_USER_SELECTOR, text: `{{ ${v}.username }}`, description: "The user name or email field of the sign-in form" },
    },
    {
      id: newStepId(),
      type: "browser.type",
      label: "Type the password and sign in",
      props: { selector: SIGN_IN_PASSWORD_SELECTOR, text: `{{ ${v}.password }}`, pressEnter: true, description: "The password field of the sign-in form" },
    },
    // Signed in once the sign-in form is gone (a wrong password leaves it there, and this step fails).
    {
      id: newStepId(),
      type: "browser.verifyVisible",
      label: "Check the sign-in worked",
      props: { selector: SIGN_IN_PASSWORD_SELECTOR, visible: false, timeoutMs: 20000 },
    },
  ];
  if (thenUrl && thenUrl !== signInUrl) steps.push({ id: newStepId(), type: "browser.navigate", label: "Go to the website", props: { url: thenUrl } });
  return steps;
}
