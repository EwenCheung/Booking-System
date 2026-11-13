import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, requireFlags } from "../src/args.js";

test("parses positional commands and flag forms", () => {
  assert.deepEqual(
    parseArguments([
      "queue",
      "add",
      "--activity",
      "Badminton",
      "--headed",
      "--max-price=2.50",
    ]),
    {
      positional: ["queue", "add"],
      flags: { activity: "Badminton", headed: true, "max-price": "2.50" },
    },
  );
});

test("reports all missing required flags", () => {
  assert.throws(
    () => requireFlags({ activity: "Badminton" }, ["activity", "venue", "date"]),
    /--venue, --date/,
  );
});
