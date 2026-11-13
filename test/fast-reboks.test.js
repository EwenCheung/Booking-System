import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormSubmission,
  parseCatalogHtml,
  parseTimeslotsHtml,
} from "../src/fast-reboks.js";

test("parses the activity catalog embedded by REBOKS", () => {
  const html = `<script>PHPJS.activity_list = [{"activity_id":"58","name":"Badminton"}];</script>`;
  assert.deepEqual(parseCatalogHtml(html), [{ id: "58", name: "Badminton" }]);
});

test("parses REBOKS-style timeslot values without rendering a browser", () => {
  const slots = parseTimeslotsHtml(`
    <div class="timeslot-container">
      <label>Court 01, 6:00 PM - 7:00 PM
        <input name="timeslots[]" type="checkbox"
          value="Court 01;15;128450;18:00:00;19:00:00">
      </label>
      <label>Court 02, 7:00 PM - 8:00 PM
        <input name="timeslots[]" type="checkbox" disabled
          value="Court 02;15;128451;19:00:00;20:00:00">
      </label>
    </div>
  `);
  assert.equal(slots.length, 2);
  assert.match(slots[0].label, /Court 01/);
  assert.equal(slots[0].disabled, false);
  assert.equal(slots[1].disabled, true);
});

test("builds a deterministic form post including an AJAX-loaded slot", () => {
  const form = buildFormSubmission(
    `<form id="formTimeslots" action="/process" method="post">
       <input type="hidden" name="csrf_test_name" value="token">
       <input type="text" name="remark" value="">
       <button type="submit" name="submit" value="Book">Book</button>
     </form>`,
    "https://reboks.nus.edu.sg/facilities/view",
    "#formTimeslots",
    {
      selectedSlot: {
        name: "timeslots[]",
        value: "Court 01;15;128450;18:00:00;19:00:00",
      },
    },
  );
  assert.equal(form.action, "https://reboks.nus.edu.sg/process");
  assert.equal(form.method, "POST");
  assert.equal(form.parameters.get("csrf_test_name"), "token");
  assert.equal(form.parameters.get("remark"), "");
  assert.equal(
    form.parameters.get("timeslots[]"),
    "Court 01;15;128450;18:00:00;19:00:00",
  );
  assert.equal(form.parameters.get("submit"), "Book");
});
