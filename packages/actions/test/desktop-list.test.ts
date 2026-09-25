import { describe, expect, it } from "vitest";
import { similarFromChain } from "../src/desktop/selector.js";

describe("the list a desktop element belongs to", () => {
  it("is its nearest list item, with only its type and class, and the part inside it", () => {
    const chain = [
      { type: "window", name: "VI Monitor", process: "vimonitor" },
      { type: "list", id: "CameraList" },
      { type: "listitem", name: "192.168.7.10 - i-PRO - S666", class: "CameraRow" },
      { type: "text", name: "192.168.7.10 - i-PRO - S666" },
    ];
    expect(similarFromChain(chain)).toEqual({
      items: 'window[process="vimonitor"] > list[id="CameraList"] > listitem[class="CameraRow"]',
      inner: "text",
    });
    // A button that is not in a list has no list.
    expect(similarFromChain([{ type: "window", process: "calc" }, { type: "button", name: "7" }])).toBeUndefined();
  });
});
